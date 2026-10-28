/**
 * TP-Link Archer BE230 Network & DHCP Manager Card - Theme-Aware Lovelace Web Component
 * Supports:
 * - Compact Front-Page Overview mode (`overview: true`)
 * - Full Network Detail mode (`overview: false`) with IP, MAC, Network badges & 1-click IP Pinning
 * - Interactive DHCP Manager (`view: "dhcp"` or toggled via header tab) to manage Static IP
 *   Reservations, Active DHCP Leases, and DHCP Server Pool/DNS settings directly from Home Assistant.
 */
class TplinkBe230Card extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._overview = false;
    this._flowOnly = false;
    this._diagramOnly = false;
    this._compact = false;
    this._view = "clients"; // clients | flow | dhcp
    this._filter = "active"; // active | all | 5g | 2g | wired | guest_iot | reserved
    this._dhcpFilter = "all"; // all | reserved | dynamic
    this._ovBandFilter = "all";
    this._flowBandFilter = "all"; // all | 5g | 2g | wired | guest_iot
    this._flowMetric = "auto"; // auto | live | phy | traffic
    this._search = "";
    this._copiedText = null;

    // DHCP Editor State
    this._editingReservation = null; // { mac, ip, hostname, isNew }
    this._editingPool = false;
    this._busy = false;
    this._statusMsg = null; // { text, type: "ok" | "err" }
  }

  static getStubConfig() {
    return {
      title: "TP-Link Archer BE230",
      overview: false,
      compact: false,
      default_view: "clients",
      show_offline: false,
      detail_path: "/dashboard-testdashboard/network",
    };
  }

  setConfig(config) {
    this._config = {
      title: "TP-Link Archer BE230",
      overview: false,
      flow: false,
      diagram_only: false,
      compact: false,
      default_view: "clients",
      show_offline: false,
      detail_path: "/dashboard-testdashboard/network",
      summary_entity: null,
      ...config,
    };
    this._overview = Boolean(this._config.overview);
    this._flowOnly = Boolean(this._config.flow);
    this._diagramOnly = Boolean(
      this._config.diagram_only || (this._flowOnly && this._overview)
    );
    this._compact = Boolean(this._config.compact);
    if (this._flowOnly || this._config.default_view === "flow") {
      this._view = "flow";
    } else if (this._config.default_view === "dhcp") {
      this._view = "dhcp";
    } else {
      this._view = "clients";
    }
    if (this._config.show_offline) {
      this._filter = "all";
    }
    this._buildSkeleton();
    if (this._hass) {
      this._render();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    // Avoid clobbering active form inputs while user is typing in DHCP editor
    if (this._editingReservation || this._editingPool) return;
    this._render();
  }

  getCardSize() {
    if (this._overview) return 4;
    return this._compact ? 5 : 8;
  }

  getGridOptions() {
    return {
      columns: 12,
      min_columns: 6,
      rows: "auto",
    };
  }

  _navigate(path) {
    if (!path) return;
    window.history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { composed: true }));
  }

  _openMoreInfo(entityId) {
    if (!entityId || !this._hass?.states?.[entityId]) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      })
    );
  }

  _copyValue(val, e) {
    e.stopPropagation();
    if (!val || val === "--" || val === "0.0.0.0") return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(val).catch(() => {});
    }
    this._copiedText = val;
    this._render();
    setTimeout(() => {
      if (this._copiedText === val) {
        this._copiedText = null;
        this._render();
      }
    }, 1400);
  }

  _showNotice(text, type = "ok") {
    this._statusMsg = { text, type };
    this._render();
    setTimeout(() => {
      if (this._statusMsg?.text === text) {
        this._statusMsg = null;
        this._render();
      }
    }, 4000);
  }

  async _saveReservation(mac, ip, hostname) {
    if (!this._hass) return;
    this._busy = true;
    this._editingReservation = null;
    this._render();
    try {
      await this._hass.callService("tplink_be230", "add_dhcp_reservation", {
        mac: mac.trim().toUpperCase().replace(/-/g, ":"),
        ip: ip.trim(),
        hostname: (hostname || "").trim(),
        enable: true,
      });
      this._showNotice(`Saved static reservation: ${ip} → ${mac}`, "ok");
    } catch (err) {
      this._showNotice(`Error saving reservation: ${err?.message || err}`, "err");
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _deleteReservation(mac) {
    if (!this._hass) return;
    this._busy = true;
    this._editingReservation = null;
    this._render();
    try {
      await this._hass.callService("tplink_be230", "delete_dhcp_reservation", {
        mac: mac.trim().toUpperCase().replace(/-/g, ":"),
      });
      this._showNotice(`Removed static reservation for ${mac}`, "ok");
    } catch (err) {
      this._showNotice(`Error removing reservation: ${err?.message || err}`, "err");
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _savePoolSettings(settings) {
    if (!this._hass) return;
    this._busy = true;
    this._editingPool = false;
    this._render();
    try {
      await this._hass.callService("tplink_be230", "set_dhcp_server", settings);
      this._showNotice("Updated DHCP Server pool & DNS settings", "ok");
    } catch (err) {
      this._showNotice(`Error updating DHCP Server: ${err?.message || err}`, "err");
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _discoverData() {
    const states = this._hass?.states || {};
    const trackerByMac = new Map();
    let summarySensor = null;
    let dhcpSensor = null;

    if (this._config.summary_entity && states[this._config.summary_entity]) {
      summarySensor = states[this._config.summary_entity];
    } else {
      for (const [eid, st] of Object.entries(states)) {
        if (
          eid.startsWith("sensor.") &&
          Array.isArray(st.attributes?.devices) &&
          (st.attributes?.model?.includes("BE230") ||
            eid.includes("be230") ||
            eid.includes("dispositivos_conectados"))
        ) {
          summarySensor = st;
        }
        if (eid.startsWith("sensor.") && eid.includes("dhcp_reservations")) {
          dhcpSensor = st;
        }
      }
    }

    const attrs = summarySensor?.attributes || {};
    const dhcpServer = attrs.dhcp_server || dhcpSensor?.attributes?.dhcp_server || {};
    const rawReservations = attrs.dhcp_reservations || dhcpSensor?.attributes?.reservations || [];
    const rawLeases = attrs.dhcp_leases || dhcpSensor?.attributes?.leases || [];

    const resByMac = new Map();
    for (const r of rawReservations) {
      const m = String(r.mac || "").toUpperCase().replace(/-/g, ":");
      if (m) resByMac.set(m, r);
    }

    const leaseByMac = new Map();
    for (const l of rawLeases) {
      const m = String(l.mac || "").toUpperCase().replace(/-/g, ":");
      if (m) leaseByMac.set(m, l);
    }

    for (const [eid, st] of Object.entries(states)) {
      if (!eid.startsWith("device_tracker.")) continue;
      const a = st.attributes || {};
      const isBe230 =
        a.integration === "tplink_be230" ||
        Boolean(a.router_entry_id) ||
        (a.source_type === "router" && (a.network || a.network_type));
      if (!isBe230) continue;

      const mac = String(a.mac || a.mac_address || "")
        .toUpperCase()
        .replace(/-/g, ":");
      if (!mac) continue;

      const resInfo = resByMac.get(mac);
      const leaseInfo = leaseByMac.get(mac);

      trackerByMac.set(mac, {
        entityId: eid,
        hostname: a.hostname || a.friendly_name || resInfo?.hostname || eid.replace("device_tracker.", ""),
        ip: a.ip || a.ip_address || resInfo?.ip || "--",
        mac,
        network: a.network || this._labelForType(a.network_type),
        network_type: a.network_type || "unknown",
        band: a.band || this._bandForType(a.network_type),
        active: st.state === "home" || Boolean(a.active),
        is_reserved: Boolean(a.is_reserved || resInfo),
        reserved_ip: a.reserved_ip || resInfo?.ip || null,
        reservation_name: a.reservation_name || resInfo?.hostname || null,
        lease_time: a.lease_time || leaseInfo?.lease_time || null,
        signal: a.signal ?? null,
        packets_sent: a.packets_sent ?? null,
        packets_received: a.packets_received ?? null,
        down_speed: a.down_speed ?? null,
        up_speed: a.up_speed ?? null,
        tx_rate: a.tx_rate ?? null,
        rx_rate: a.rx_rate ?? null,
        traffic_usage: a.traffic_usage ?? null,
        online_time: a.online_time ?? null,
        last_seen: a.last_seen ?? null,
      });
    }

    if (summarySensor && Array.isArray(summarySensor.attributes?.devices)) {
      for (const d of summarySensor.attributes.devices) {
        const mac = String(d.mac || "")
          .toUpperCase()
          .replace(/-/g, ":");
        if (!mac) continue;
        const existing = trackerByMac.get(mac);
        const resInfo = resByMac.get(mac);
        const leaseInfo = leaseByMac.get(mac);
        trackerByMac.set(mac, {
          entityId: existing?.entityId || null,
          hostname: d.hostname || existing?.hostname || resInfo?.hostname || `Device ${mac.slice(-8)}`,
          ip: d.ip || existing?.ip || resInfo?.ip || "--",
          mac,
          network: d.network || existing?.network || this._labelForType(d.network_type),
          network_type: d.network_type || existing?.network_type || "unknown",
          band: d.band || existing?.band || this._bandForType(d.network_type),
          active: d.active !== undefined ? Boolean(d.active) : Boolean(existing?.active),
          is_reserved: Boolean(d.is_reserved ?? existing?.is_reserved ?? resInfo),
          reserved_ip: d.reserved_ip || existing?.reserved_ip || resInfo?.ip || null,
          reservation_name: d.reservation_name || existing?.reservation_name || resInfo?.hostname || null,
          lease_time: d.lease_time || existing?.lease_time || leaseInfo?.lease_time || null,
          signal: d.signal ?? existing?.signal ?? null,
          packets_sent: d.packets_sent ?? existing?.packets_sent ?? null,
          packets_received: d.packets_received ?? existing?.packets_received ?? null,
          down_speed: d.down_speed ?? existing?.down_speed ?? null,
          up_speed: d.up_speed ?? existing?.up_speed ?? null,
          tx_rate: d.tx_rate ?? existing?.tx_rate ?? null,
          rx_rate: d.rx_rate ?? existing?.rx_rate ?? null,
          traffic_usage: d.traffic_usage ?? existing?.traffic_usage ?? null,
          online_time: d.online_time ?? existing?.online_time ?? null,
          last_seen: d.last_seen ?? existing?.last_seen ?? null,
        });
      }
    }

    // Ensure any reservation or lease not yet in trackerByMac is included
    for (const [mac, r] of resByMac.entries()) {
      if (!trackerByMac.has(mac)) {
        trackerByMac.set(mac, {
          entityId: null,
          hostname: r.hostname || `Device ${mac.slice(-8)}`,
          ip: r.ip || "--",
          mac,
          network: "Reserved (Offline)",
          network_type: "unknown",
          band: "Offline",
          active: false,
          is_reserved: true,
          reserved_ip: r.ip,
          reservation_name: r.hostname,
          lease_time: "Permanent",
          signal: null,
        });
      }
    }

    const devices = Array.from(trackerByMac.values()).sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return this._ipToInt(a.ip) - this._ipToInt(b.ip);
    });

    return {
      summaryEntityId: summarySensor?.entity_id || null,
      model: attrs.model || "Archer BE230",
      firmware: attrs.firmware_version || null,
      wanIp: attrs.wan_ip || "--",
      lanIp: attrs.lan_ip || "192.168.1.1",
      cpuUsage: attrs.cpu_usage ?? null,
      memUsage: attrs.mem_usage ?? null,
      dhcpServer,
      reservationsCount: rawReservations.length,
      leasesCount: rawLeases.length,
      devices,
    };
  }

  _ipToInt(ip) {
    if (!ip || typeof ip !== "string") return 999999999;
    const parts = ip.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return 999999999;
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  }

  _labelForType(netType) {
    const map = {
      host_2g: "Wi-Fi 2.4GHz",
      host_5g: "Wi-Fi 5GHz",
      host_6g: "Wi-Fi 6GHz",
      host_mlo: "Wi-Fi 7 MLO",
      guest_2g: "Guest 2.4GHz",
      guest_5g: "Guest 5GHz",
      guest_6g: "Guest 6GHz",
      iot_2g: "IoT 2.4GHz",
      iot_5g: "IoT 5GHz",
      iot_6g: "IoT 6GHz",
      wired: "Ethernet (LAN)",
    };
    return map[netType] || "Unknown";
  }

  _bandForType(netType) {
    if (!netType) return "Unknown";
    if (netType === "wired") return "LAN";
    if (netType.includes("mlo")) return "MLO";
    if (netType.includes("5g")) return "5GHz";
    if (netType.includes("2g")) return "2.4GHz";
    if (netType.includes("6g")) return "6GHz";
    return "Unknown";
  }

  _networkCategory(dev) {
    const t = String(dev.network_type || "").toLowerCase();
    if (t === "wired") return "wired";
    if (t.startsWith("guest_") || t.startsWith("iot_")) return "guest_iot";
    if (t.includes("5g") || t.includes("6g") || t.includes("mlo")) return "5g";
    if (t.includes("2g")) return "2g";
    return "other";
  }

  _iconForDevice(dev) {
    const cat = this._networkCategory(dev);
    if (cat === "wired") return dev.active ? "mdi:lan-connect" : "mdi:lan-disconnect";
    if (cat === "guest_iot") return "mdi:access-point-network";
    if (String(dev.network_type).includes("mlo")) return "mdi:wifi-star";
    return dev.active ? "mdi:wifi" : "mdi:wifi-off";
  }

  _buildSkeleton() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--ha-card-header-font-family, var(--primary-font-family, inherit));
          --be-bg: var(--ha-card-background, var(--card-background-color, #23242b));
          --be-surface: var(--secondary-background-color, rgba(128, 128, 128, 0.08));
          --be-input: var(--input-fill-color, rgba(128, 128, 128, 0.14));
          --be-divider: var(--divider-color, rgba(128, 128, 128, 0.18));
          --be-text-primary: var(--primary-text-color, #e4e4e7);
          --be-text-secondary: var(--secondary-text-color, #9496a4);
          --be-accent: var(--primary-color, #00b4d8);
          --be-online: var(--success-color, #22c55e);
          --be-warn: var(--warning-color, #fbbf24);
          --be-danger: var(--error-color, #ef4444);
          --be-5g: #38bdf8;
          --be-2g: #a78bfa;
          --be-lan: #34d399;
          --be-guest: #fbbf24;
          --be-offline: #6b7280;
        }
        ha-card {
          background: var(--be-bg);
          border-radius: var(--ha-card-border-radius, 12px);
          border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--be-divider));
          box-shadow: var(--ha-card-box-shadow, none);
          padding: 16px;
          color: var(--be-text-primary);
          overflow: hidden;
        }
        ha-card.compact, ha-card.overview {
          padding: 12px 14px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        ha-card.compact .header, ha-card.overview .header {
          margin-bottom: 9px;
        }
        .title-wrap {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .router-icon {
          width: 30px;
          height: 30px;
          border-radius: 8px;
          background: color-mix(in srgb, var(--be-accent) 16%, transparent);
          border: 1px solid color-mix(in srgb, var(--be-accent) 38%, transparent);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--be-accent);
        }
        .router-icon ha-icon {
          --mdc-icon-size: 18px;
        }
        .title {
          font-size: 1rem;
          font-weight: 600;
        }
        .subtitle {
          font-size: 0.72rem;
          color: var(--be-text-secondary);
          margin-top: 1px;
        }
        .controls {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .search-input {
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          color: var(--be-text-primary);
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 0.72rem;
          outline: none;
          width: 150px;
        }
        .search-input:focus {
          border-color: var(--be-accent);
        }
        .pill-group {
          display: flex;
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          border-radius: 999px;
          padding: 2px;
          gap: 2px;
          flex-wrap: wrap;
        }
        button.btn {
          appearance: none;
          border: 1px solid transparent;
          background: transparent;
          color: var(--be-text-secondary);
          font-family: inherit;
          font-size: 0.7rem;
          font-weight: 600;
          padding: 3px 9px;
          border-radius: 999px;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        button.btn:hover {
          color: var(--be-text-primary);
          background: var(--be-input);
        }
        button.btn.active {
          background: color-mix(in srgb, var(--be-accent) 18%, transparent);
          color: var(--be-accent);
          border-color: color-mix(in srgb, var(--be-accent) 42%, transparent);
        }
        button.btn.primary {
          background: color-mix(in srgb, var(--be-online) 18%, transparent);
          color: var(--be-online);
          border-color: color-mix(in srgb, var(--be-online) 42%, transparent);
        }
        button.btn.danger {
          background: color-mix(in srgb, var(--be-danger) 16%, transparent);
          color: var(--be-danger);
          border-color: color-mix(in srgb, var(--be-danger) 38%, transparent);
        }

        /* Notice Banner */
        .notice {
          padding: 7px 11px;
          border-radius: 8px;
          font-size: 0.74rem;
          font-weight: 600;
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .notice.ok {
          background: color-mix(in srgb, var(--be-online) 16%, transparent);
          border: 1px solid color-mix(in srgb, var(--be-online) 40%, transparent);
          color: var(--be-online);
        }
        .notice.err {
          background: color-mix(in srgb, var(--be-danger) 16%, transparent);
          border: 1px solid color-mix(in srgb, var(--be-danger) 40%, transparent);
          color: var(--be-danger);
        }

        /* Inline DHCP Editor Form */
        .editor-box {
          background: var(--be-surface);
          border: 1px solid color-mix(in srgb, var(--be-accent) 50%, var(--be-divider));
          border-radius: 10px;
          padding: 12px;
          margin-bottom: 12px;
        }
        .editor-title {
          font-size: 0.8rem;
          font-weight: 700;
          margin-bottom: 8px;
          color: var(--be-accent);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .editor-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 8px;
          margin-bottom: 10px;
        }
        .field-label {
          font-size: 0.65rem;
          color: var(--be-text-secondary);
          margin-bottom: 3px;
          display: block;
          font-weight: 600;
        }
        .field-input {
          width: 100%;
          box-sizing: border-box;
          background: var(--be-input);
          border: 1px solid var(--be-divider);
          border-radius: 6px;
          padding: 5px 8px;
          color: var(--be-text-primary);
          font-size: 0.75rem;
          font-family: inherit;
          outline: none;
        }
        .field-input:focus {
          border-color: var(--be-accent);
        }
        .editor-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
        }

        /* Overview Mode Styles */
        .kpi-row {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
          margin-bottom: 8px;
        }
        .kpi-box {
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          border-radius: 8px;
          padding: 6px 8px;
          text-align: center;
        }
        .kpi-val {
          font-size: 0.88rem;
          font-weight: 700;
          color: var(--be-text-primary);
        }
        .kpi-lbl {
          font-size: 0.62rem;
          color: var(--be-text-secondary);
          margin-top: 1px;
        }
        .band-bar {
          display: flex;
          height: 6px;
          border-radius: 999px;
          overflow: hidden;
          background: var(--be-surface);
          margin-bottom: 7px;
          gap: 2px;
        }
        .band-seg.cat-5g { background: var(--be-5g); }
        .band-seg.cat-2g { background: var(--be-2g); }
        .band-seg.cat-guest_iot { background: var(--be-guest); }
        .band-seg.cat-wired { background: var(--be-lan); }
        .band-pills {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 4px;
          margin-bottom: 9px;
          flex-wrap: wrap;
        }
        .band-pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 0.66rem;
          font-weight: 600;
          padding: 3px 8px;
          border-radius: 999px;
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          color: var(--be-text-secondary);
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .band-pill.active {
          color: var(--be-text-primary);
          border-color: var(--be-accent);
          background: var(--be-input);
        }
        .b-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
        }
        .b-dot.cat-5g { background: var(--be-5g); }
        .b-dot.cat-2g { background: var(--be-2g); }
        .b-dot.cat-guest_iot { background: var(--be-guest); }
        .b-dot.cat-wired { background: var(--be-lan); }

        .ov-devices-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 5px;
          max-height: 215px;
          overflow-y: auto;
          padding-right: 2px;
        }
        .ov-chip {
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          border-radius: 8px;
          padding: 5px 8px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          cursor: pointer;
          min-width: 0;
          transition: border-color 0.15s ease;
        }
        .ov-chip:hover {
          border-color: color-mix(in srgb, var(--be-accent) 45%, var(--be-divider));
        }
        .ov-left {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        .ov-name {
          font-size: 0.73rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ov-ip {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 0.65rem;
          color: var(--be-text-secondary);
          background: var(--be-input);
          padding: 1px 5px;
          border-radius: 5px;
          flex-shrink: 0;
        }

        /* Detailed Mode & DHCP Manager Styles */
        .summary-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 8px;
          padding: 8px 12px;
          margin-bottom: 12px;
          border-radius: 9px;
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          font-size: 0.73rem;
          color: var(--be-text-secondary);
        }
        .summary-metrics {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }
        .summary-bar strong {
          color: var(--be-text-primary);
        }
        .devices-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 9px;
        }
        @media (max-width: 520px) {
          .devices-grid {
            grid-template-columns: 1fr;
          }
        }
        ha-card.compact .devices-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
        }
        .device-card {
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          border-radius: 10px;
          padding: 9px 11px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 7px;
          height: 74px;
          box-sizing: border-box;
          cursor: pointer;
          transition: border-color 0.15s ease;
        }
        .device-card:hover {
          border-color: color-mix(in srgb, var(--be-accent) 45%, var(--be-divider));
        }
        .device-card.cat-5g { border-left: 3px solid var(--be-5g); }
        .device-card.cat-2g { border-left: 3px solid var(--be-2g); }
        .device-card.cat-wired { border-left: 3px solid var(--be-lan); }
        .device-card.cat-guest_iot { border-left: 3px solid var(--be-guest); }
        .device-card.offline {
          border-left: 3px solid var(--be-offline);
          opacity: 0.65;
        }
        ha-card.compact .device-card {
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
          height: 46px;
          padding: 6px 10px;
          border-radius: 8px;
        }
        .dev-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          min-width: 0;
          flex-wrap: nowrap;
        }
        .dev-id {
          display: flex;
          align-items: center;
          gap: 7px;
          min-width: 0;
          flex: 1;
        }
        .dev-icon {
          width: 24px;
          height: 24px;
          border-radius: 6px;
          background: var(--be-input);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--be-text-primary);
          flex-shrink: 0;
        }
        .dev-icon ha-icon {
          --mdc-icon-size: 15px;
        }
        .dev-name {
          font-size: 0.8rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .net-badge {
          font-size: 0.63rem;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 999px;
          white-space: nowrap;
          flex-shrink: 0;
          border: 1px solid transparent;
        }
        .net-badge.cat-5g {
          background: color-mix(in srgb, var(--be-5g) 16%, transparent);
          color: var(--be-5g);
          border-color: color-mix(in srgb, var(--be-5g) 35%, transparent);
        }
        .net-badge.cat-2g {
          background: color-mix(in srgb, var(--be-2g) 16%, transparent);
          color: var(--be-2g);
          border-color: color-mix(in srgb, var(--be-2g) 35%, transparent);
        }
        .net-badge.cat-wired {
          background: color-mix(in srgb, var(--be-lan) 16%, transparent);
          color: var(--be-lan);
          border-color: color-mix(in srgb, var(--be-lan) 35%, transparent);
        }
        .net-badge.cat-guest_iot {
          background: color-mix(in srgb, var(--be-guest) 16%, transparent);
          color: var(--be-guest);
          border-color: color-mix(in srgb, var(--be-guest) 35%, transparent);
        }
        .dev-badges {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 5px;
          flex-wrap: nowrap;
          min-width: 0;
        }
        .dev-pills-left {
          display: flex;
          align-items: center;
          gap: 4px;
          flex-wrap: nowrap;
          min-width: 0;
          overflow: hidden;
        }
        .mono-pill {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 0.65rem;
          padding: 2px 5px;
          border-radius: 5px;
          background: var(--be-input);
          border: 1px solid var(--be-divider);
          color: var(--be-text-primary);
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 3px;
          white-space: nowrap;
          flex-shrink: 0;
          transition: border-color 0.15s ease;
        }
        .mono-pill:hover {
          border-color: var(--be-accent);
        }
        .mono-pill .lbl {
          color: var(--be-text-secondary);
          font-size: 0.59rem;
          font-weight: 600;
        }
        .dhcp-tag {
          font-size: 0.62rem;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 5px;
          cursor: pointer;
          white-space: nowrap;
          flex-shrink: 0;
          border: 1px solid var(--be-divider);
          background: var(--be-input);
          color: var(--be-text-secondary);
          transition: all 0.15s ease;
        }
        .dhcp-tag.reserved {
          background: color-mix(in srgb, var(--be-online) 16%, transparent);
          border-color: color-mix(in srgb, var(--be-online) 40%, transparent);
          color: var(--be-online);
        }
        .dhcp-tag:hover {
          border-color: var(--be-accent);
          color: var(--be-text-primary);
        }

        /* DHCP Table Layout */
        .dhcp-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .dhcp-row {
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          border-radius: 9px;
          padding: 8px 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }
        .dhcp-row.reserved {
          border-left: 3px solid var(--be-online);
        }
        .dhcp-row.dynamic {
          border-left: 3px solid var(--be-5g);
        }
        .dhcp-main {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 180px;
          flex: 1;
        }
        .dhcp-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .dhcp-actions {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .empty-state {
          text-align: center;
          padding: 20px;
          color: var(--be-text-secondary);
          font-size: 0.8rem;
        }

        /* =================================================================
           Network Traffic & TX/RX Distribution Flow View (Power-Card Style)
           ================================================================= */
        .flow-diagram-wrap {
          position: relative;
          width: 100%;
          aspect-ratio: 560 / 310;
          max-height: 325px;
          margin: 4px auto 10px auto;
          user-select: none;
        }
        ha-card.compact .flow-diagram-wrap {
          aspect-ratio: 560 / 245;
          max-height: 245px;
        }
        svg.flow-svg {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          overflow: visible;
        }
        .flow-path {
          fill: none;
          stroke-width: 2;
          stroke-linecap: round;
          opacity: 0.52;
          transition: opacity 0.25s ease, stroke-width 0.25s ease;
        }
        .flow-path.inactive {
          opacity: 0.14;
          stroke-dasharray: 3 4;
        }
        .flow-node {
          position: absolute;
          transform: translate(-50%, -50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          cursor: pointer;
          z-index: 2;
        }
        .flow-node-label {
          font-size: 0.68rem;
          font-weight: 600;
          color: var(--be-text-secondary);
          margin-bottom: 3px;
          white-space: nowrap;
          max-width: 96px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .flow-node-label.bottom {
          margin-bottom: 0;
          margin-top: 3px;
        }
        .flow-circle {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          background: var(--be-bg);
          border: 2px solid var(--node-color, var(--be-divider));
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1px;
          transition: transform 0.16s ease, box-shadow 0.2s ease, border-color 0.2s ease;
          box-sizing: border-box;
        }
        .flow-node:hover .flow-circle {
          transform: scale(1.06);
          box-shadow: 0 0 14px color-mix(in srgb, var(--node-color, var(--be-accent)) 35%, transparent);
        }
        .flow-circle.selected {
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--node-color, var(--be-accent)) 32%, transparent);
        }
        .flow-circle.lg {
          width: 76px;
          height: 76px;
          border-width: 2.5px;
        }
        .flow-circle.sm {
          width: 54px;
          height: 54px;
          border-width: 1.8px;
        }
        ha-card.compact .flow-circle {
          width: 54px;
          height: 54px;
        }
        ha-card.compact .flow-circle.lg {
          width: 64px;
          height: 64px;
        }
        ha-card.compact .flow-circle.sm {
          width: 46px;
          height: 46px;
        }
        .flow-circle.inactive {
          opacity: 0.45;
          border-style: dashed;
        }
        .flow-circle ha-icon {
          --mdc-icon-size: 18px;
          color: var(--node-color, var(--be-text-primary));
        }
        .flow-circle.lg ha-icon {
          --mdc-icon-size: 22px;
        }
        .flow-circle.sm ha-icon {
          --mdc-icon-size: 15px;
        }
        .flow-val {
          font-size: 0.68rem;
          font-weight: 700;
          color: var(--be-text-primary);
          line-height: 1.05;
          white-space: nowrap;
        }
        .flow-sub {
          font-size: 0.58rem;
          color: var(--be-text-secondary);
          line-height: 1;
          white-space: nowrap;
        }
        ha-card.compact .flow-sub {
          display: none;
        }

        /* Proportional Breakdown Bar */
        .dist-section {
          margin-top: 8px;
          margin-bottom: 12px;
          padding-top: 9px;
          border-top: 1px solid var(--be-divider);
        }
        .dist-bar {
          display: flex;
          width: 100%;
          height: 8px;
          border-radius: 4px;
          overflow: hidden;
          background: var(--be-input);
          gap: 1px;
        }
        .dist-seg {
          height: 100%;
          transition: width 0.35s ease;
        }
        .dist-legend {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-top: 6px;
          font-size: 0.68rem;
          color: var(--be-text-secondary);
        }
        .dist-item {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
        }
        .dist-dot {
          width: 8px;
          height: 8px;
          border-radius: 2px;
        }
        .dist-item strong {
          color: var(--be-text-primary);
          font-weight: 600;
        }

        /* Reactive Active Devices TX/RX Distribution Matrix */
        .flow-matrix-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: 0.72rem;
          font-weight: 600;
          color: var(--be-text-secondary);
        }
        .flow-devices-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        @media (max-width: 520px) {
          .flow-devices-grid {
            grid-template-columns: 1fr;
          }
        }
        .flow-dev-card {
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          border-radius: 10px;
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          cursor: pointer;
          transition: border-color 0.18s ease, transform 0.15s ease;
          min-width: 0;
        }
        .flow-dev-card:hover {
          border-color: color-mix(in srgb, var(--be-accent) 48%, var(--be-divider));
        }
        .flow-dev-card.cat-5g { border-left: 3px solid var(--be-5g); }
        .flow-dev-card.cat-2g { border-left: 3px solid var(--be-2g); }
        .flow-dev-card.cat-wired { border-left: 3px solid var(--be-lan); }
        .flow-dev-card.cat-guest_iot { border-left: 3px solid var(--be-guest); }

        .flow-dev-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          min-width: 0;
        }
        .flow-dev-meta {
          font-size: 0.62rem;
          color: var(--be-text-secondary);
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .txrx-bars {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .txrx-row {
          display: grid;
          grid-template-columns: 28px 1fr 68px;
          align-items: center;
          gap: 6px;
          font-size: 0.64rem;
        }
        .txrx-lbl {
          font-weight: 700;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          letter-spacing: -0.02em;
        }
        .txrx-lbl.rx { color: var(--be-5g); }
        .txrx-lbl.tx { color: var(--be-2g); }
        .txrx-track {
          height: 6px;
          border-radius: 999px;
          background: var(--be-input);
          overflow: hidden;
          position: relative;
        }
        .txrx-fill {
          height: 100%;
          border-radius: 999px;
          transition: width 0.4s cubic-bezier(0.22, 1, 0.36, 1);
          position: relative;
        }
        .txrx-fill.rx {
          background: linear-gradient(90deg, color-mix(in srgb, var(--be-5g) 65%, transparent), var(--be-5g));
        }
        .txrx-fill.tx {
          background: linear-gradient(90deg, color-mix(in srgb, var(--be-2g) 65%, transparent), var(--be-2g));
        }
        .txrx-val {
          text-align: right;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-weight: 600;
          color: var(--be-text-primary);
          white-space: nowrap;
        }
        .flow-dev-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 0.61rem;
          color: var(--be-text-secondary);
          padding-top: 2px;
          border-top: 1px dashed color-mix(in srgb, var(--be-divider) 65%, transparent);
        }
      </style>
      <ha-card id="card-root">
        <div class="header">
          <div class="title-wrap">
            <div class="router-icon"><ha-icon icon="mdi:router-wireless"></ha-icon></div>
            <div>
              <div class="title" id="card-title"></div>
              <div class="subtitle" id="card-subtitle"></div>
            </div>
          </div>
          <div class="controls" id="header-controls"></div>
        </div>
        <div id="notice-area"></div>
        <div id="editor-area"></div>
        <div id="card-body"></div>
      </ha-card>
    `;
  }

  _renderEditor(data) {
    const editorArea = this.shadowRoot.getElementById("editor-area");
    if (!editorArea) return;

    if (this._editingReservation) {
      const r = this._editingReservation;
      editorArea.innerHTML = `
        <div class="editor-box">
          <div class="editor-title">
            <span>📌 ${r.isNew ? "Create Static DHCP Reservation" : `Edit Static IP Reservation (${this._escape(r.hostname)})`}</span>
          </div>
          <div class="editor-grid">
            <div>
              <label class="field-label">MAC Address</label>
              <input class="field-input" id="ed-mac" value="${this._escape(r.mac)}" placeholder="AA:BB:CC:DD:EE:FF" />
            </div>
            <div>
              <label class="field-label">Reserved IPv4 Address</label>
              <input class="field-input" id="ed-ip" value="${this._escape(r.ip)}" placeholder="192.168.1.50" />
            </div>
            <div>
              <label class="field-label">Description / Hostname</label>
              <input class="field-input" id="ed-name" value="${this._escape(r.hostname)}" placeholder="homelab-node" />
            </div>
          </div>
          <div class="editor-actions">
            ${
              !r.isNew && r.alreadyReserved
                ? `<button class="btn danger" id="ed-delete">🗑️ Remove Reservation</button>`
                : ""
            }
            <button class="btn" id="ed-cancel">Cancel</button>
            <button class="btn primary" id="ed-save">${this._busy ? "Saving..." : "💾 Save to Router"}</button>
          </div>
        </div>
      `;
      editorArea.querySelector("#ed-cancel")?.addEventListener("click", () => {
        this._editingReservation = null;
        this._render();
      });
      editorArea.querySelector("#ed-delete")?.addEventListener("click", () => {
        this._deleteReservation(r.mac);
      });
      editorArea.querySelector("#ed-save")?.addEventListener("click", () => {
        const mac = editorArea.querySelector("#ed-mac").value;
        const ip = editorArea.querySelector("#ed-ip").value;
        const name = editorArea.querySelector("#ed-name").value;
        if (mac && ip) {
          this._saveReservation(mac, ip, name);
        }
      });
      return;
    }

    if (this._editingPool) {
      const s = data.dhcpServer || {};
      editorArea.innerHTML = `
        <div class="editor-box">
          <div class="editor-title">
            <span>⚙️ DHCP Server Pool & DNS Configuration</span>
          </div>
          <div class="editor-grid">
            <div>
              <label class="field-label">Start IP Address</label>
              <input class="field-input" id="pool-start" value="${this._escape(s.ip_start || "192.168.1.100")}" />
            </div>
            <div>
              <label class="field-label">End IP Address</label>
              <input class="field-input" id="pool-end" value="${this._escape(s.ip_end || "192.168.1.199")}" />
            </div>
            <div>
              <label class="field-label">Lease Time (minutes)</label>
              <input class="field-input" id="pool-lease" value="${this._escape(s.lease_time || "120")}" />
            </div>
            <div>
              <label class="field-label">Default Gateway</label>
              <input class="field-input" id="pool-gw" value="${this._escape(s.gateway || data.lanIp || "192.168.1.1")}" />
            </div>
            <div>
              <label class="field-label">Primary DNS</label>
              <input class="field-input" id="pool-dns1" value="${this._escape(s.pri_dns || "")}" placeholder="1.1.1.1" />
            </div>
            <div>
              <label class="field-label">Secondary DNS</label>
              <input class="field-input" id="pool-dns2" value="${this._escape(s.snd_dns || "")}" placeholder="8.8.8.8" />
            </div>
          </div>
          <div class="editor-actions">
            <button class="btn" id="pool-cancel">Cancel</button>
            <button class="btn primary" id="pool-save">${this._busy ? "Saving..." : "💾 Update DHCP Server"}</button>
          </div>
        </div>
      `;
      editorArea.querySelector("#pool-cancel")?.addEventListener("click", () => {
        this._editingPool = false;
        this._render();
      });
      editorArea.querySelector("#pool-save")?.addEventListener("click", () => {
        this._savePoolSettings({
          enabled: true,
          ip_start: editorArea.querySelector("#pool-start").value.trim(),
          ip_end: editorArea.querySelector("#pool-end").value.trim(),
          lease_time: editorArea.querySelector("#pool-lease").value.trim(),
          gateway: editorArea.querySelector("#pool-gw").value.trim(),
          pri_dns: editorArea.querySelector("#pool-dns1").value.trim(),
          snd_dns: editorArea.querySelector("#pool-dns2").value.trim(),
        });
      });
      return;
    }

    editorArea.innerHTML = "";
  }

  _render() {
    if (!this.shadowRoot || !this._hass) return;
    const data = this._discoverData();

    const cardRoot = this.shadowRoot.getElementById("card-root");
    cardRoot.classList.toggle("compact", this._compact && !this._overview);
    cardRoot.classList.toggle("overview", this._overview);

    this.shadowRoot.getElementById("card-title").textContent =
      this._config.title || `TP-Link ${data.model}`;

    const noticeArea = this.shadowRoot.getElementById("notice-area");
    if (this._statusMsg) {
      noticeArea.innerHTML = `<div class="notice ${this._statusMsg.type}"><span>${this._escape(this._statusMsg.text)}</span></div>`;
    } else {
      noticeArea.innerHTML = "";
    }

    this._renderEditor(data);

    const activeDevices = data.devices.filter((d) => d.active);
    const activeCount = activeDevices.length;
    const reservedCount = data.devices.filter((d) => d.is_reserved).length;
    const count5g = activeDevices.filter((d) => this._networkCategory(d) === "5g").length;
    const count2g = activeDevices.filter((d) => this._networkCategory(d) === "2g").length;
    const countWired = activeDevices.filter((d) => this._networkCategory(d) === "wired").length;
    const countGuestIot = activeDevices.filter((d) => this._networkCategory(d) === "guest_iot").length;

    const subtitleEl = this.shadowRoot.getElementById("card-subtitle");
    const controlsEl = this.shadowRoot.getElementById("header-controls");
    const bodyEl = this.shadowRoot.getElementById("card-body");

    if (this._flowOnly) {
      this._renderFlowView(data, controlsEl, bodyEl, subtitleEl, reservedCount);
      return;
    }

    if (this._overview) {
      subtitleEl.textContent = `${activeCount} active clients · ${reservedCount} static DHCP · LAN ${data.lanIp}`;
      controlsEl.innerHTML = `
        <div class="pill-group">
          <button class="btn active" id="btn-detail" title="Go to Network tab">Details →</button>
        </div>
      `;
      controlsEl.querySelector("#btn-detail")?.addEventListener("click", () => {
        this._navigate(this._config.detail_path || "/dashboard-testdashboard/network");
      });

      const total = Math.max(activeCount, 1);
      const p5g = Math.round((count5g / total) * 100);
      const p2g = Math.round((count2g / total) * 100);
      const pIot = Math.round((countGuestIot / total) * 100);
      const pLan = Math.round((countWired / total) * 100);

      const ovList = activeDevices.filter((d) => {
        if (this._ovBandFilter === "all") return true;
        return this._networkCategory(d) === this._ovBandFilter;
      });

      bodyEl.innerHTML = `
        <div class="kpi-row">
          <div class="kpi-box">
            <div class="kpi-val" style="color:var(--be-online)">${activeCount}</div>
            <div class="kpi-lbl">Connected</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-val">${data.cpuUsage !== null ? `${data.cpuUsage}%` : "--"}</div>
            <div class="kpi-lbl">CPU</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-val">${data.memUsage !== null ? `${data.memUsage}%` : "--"}</div>
            <div class="kpi-lbl">RAM</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-val" style="color:var(--be-5g)">${reservedCount}</div>
            <div class="kpi-lbl">Static IPs</div>
          </div>
        </div>

        <div class="band-bar">
          ${count5g > 0 ? `<div class="band-seg cat-5g" style="width:${p5g}%"></div>` : ""}
          ${count2g > 0 ? `<div class="band-seg cat-2g" style="width:${p2g}%"></div>` : ""}
          ${countGuestIot > 0 ? `<div class="band-seg cat-guest_iot" style="width:${pIot}%"></div>` : ""}
          ${countWired > 0 ? `<div class="band-seg cat-wired" style="width:${pLan}%"></div>` : ""}
        </div>

        <div class="band-pills">
          <span class="band-pill ${this._ovBandFilter === "all" ? "active" : ""}" data-ovband="all">
            All (${activeCount})
          </span>
          <span class="band-pill ${this._ovBandFilter === "5g" ? "active" : ""}" data-ovband="5g">
            <span class="b-dot cat-5g"></span> 5GHz (${count5g})
          </span>
          <span class="band-pill ${this._ovBandFilter === "2g" ? "active" : ""}" data-ovband="2g">
            <span class="b-dot cat-2g"></span> 2.4G (${count2g})
          </span>
          <span class="band-pill ${this._ovBandFilter === "guest_iot" ? "active" : ""}" data-ovband="guest_iot">
            <span class="b-dot cat-guest_iot"></span> IoT (${countGuestIot})
          </span>
          <span class="band-pill ${this._ovBandFilter === "wired" ? "active" : ""}" data-ovband="wired">
            <span class="b-dot cat-wired"></span> LAN (${countWired})
          </span>
        </div>

        <div class="ov-devices-grid" id="ov-devices"></div>
      `;

      bodyEl.querySelectorAll("[data-ovband]").forEach((pill) => {
        pill.addEventListener("click", () => {
          this._ovBandFilter = pill.dataset.ovband;
          this._render();
        });
      });

      const ovGrid = bodyEl.querySelector("#ov-devices");
      ovGrid.innerHTML = ovList
        .map((d) => {
          const cat = this._networkCategory(d);
          const isCopied = this._copiedText === d.ip;
          const shortIp = d.ip && d.ip !== "--" ? `.${d.ip.split(".").slice(-1)[0]}` : "--";
          return `
            <div class="ov-chip" data-entity="${d.entityId || ""}">
              <div class="ov-left">
                <span class="b-dot cat-${cat}"></span>
                <span class="ov-name" title="${this._escape(d.hostname)} (${this._escape(d.network)})">${this._escape(d.hostname)}</span>
              </div>
              <span class="ov-ip" data-copy="${this._escape(d.ip)}" title="Click to copy IP (${this._escape(d.ip)})">
                ${isCopied ? "Copied!" : `${d.is_reserved ? "📌" : ""}${shortIp}`}
              </span>
            </div>
          `;
        })
        .join("");

      ovGrid.querySelectorAll(".ov-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const eid = chip.dataset.entity;
          if (eid) this._openMoreInfo(eid);
        });
      });
      ovGrid.querySelectorAll("[data-copy]").forEach((pill) => {
        pill.addEventListener("click", (e) => {
          this._copyValue(pill.dataset.copy, e);
        });
      });
      return;
    }

    // Full Detailed Mode (Clients View, Traffic Flow View, OR DHCP Manager View)
    subtitleEl.textContent = `${activeCount} connected · ${reservedCount} static DHCP · 5GHz: ${count5g} · 2.4GHz: ${count2g} · IoT: ${countGuestIot} · Wired: ${countWired}`;

    if (this._flowOnly || this._view === "flow") {
      this._renderFlowView(data, controlsEl, bodyEl, subtitleEl, reservedCount);
      return;
    }

    if (this._view === "dhcp") {
      this._renderDhcpManagerView(data, controlsEl, bodyEl, reservedCount);
      return;
    }

    const filters = [
      { id: "active", label: `Active (${activeCount})` },
      { id: "5g", label: `5GHz (${count5g})` },
      { id: "2g", label: `2.4GHz (${count2g})` },
      { id: "wired", label: `LAN (${countWired})` },
    ];
    if (countGuestIot > 0) {
      filters.push({ id: "guest_iot", label: `Guest/IoT (${countGuestIot})` });
    }
    filters.push({ id: "reserved", label: `📌 Static (${reservedCount})` });
    filters.push({ id: "all", label: `All (${data.devices.length})` });

    controlsEl.innerHTML = `
      <div class="pill-group">
        <button class="btn active" id="tab-clients">Clients</button>
        <button class="btn" id="tab-flow">⚡ Traffic Flow</button>
        <button class="btn" id="tab-dhcp">DHCP Manager (${reservedCount})</button>
      </div>
      <input type="text" class="search-input" id="search-box" placeholder="Search name, IP, MAC..." value="${this._escape(this._search)}" />
      <div class="pill-group" id="filter-group">
        ${filters
          .map(
            (f) =>
              `<button class="btn ${this._filter === f.id ? "active" : ""}" data-filter="${f.id}">${f.label}</button>`
          )
          .join("")}
      </div>
      <button class="btn ${this._compact ? "active" : ""}" id="compact-btn" title="Toggle compact view">Compact</button>
    `;

    controlsEl.querySelector("#tab-flow")?.addEventListener("click", () => {
      this._view = "flow";
      this._render();
    });

    controlsEl.querySelector("#tab-dhcp")?.addEventListener("click", () => {
      this._view = "dhcp";
      this._render();
    });

    const searchBox = controlsEl.querySelector("#search-box");
    searchBox.addEventListener("input", (e) => {
      this._search = e.target.value || "";
      const pos = e.target.selectionStart;
      this._render();
      const newBox = this.shadowRoot.getElementById("search-box");
      if (newBox) {
        newBox.focus();
        newBox.setSelectionRange(pos, pos);
      }
    });

    controlsEl.querySelectorAll("button[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._filter = btn.dataset.filter;
        this._render();
      });
    });

    controlsEl.querySelector("#compact-btn")?.addEventListener("click", () => {
      this._compact = !this._compact;
      this._render();
    });

    const cpuTxt = data.cpuUsage !== null ? `<span>CPU: <strong>${data.cpuUsage}%</strong></span>` : "";
    const memTxt = data.memUsage !== null ? `<span>RAM: <strong>${data.memUsage}%</strong></span>` : "";
    const pool = data.dhcpServer || {};
    const poolTxt =
      pool.ip_start && pool.ip_end
        ? `<span>DHCP Pool: <strong>${pool.ip_start} – ${pool.ip_end}</strong></span>`
        : "";

    const q = this._search.trim().toLowerCase();
    const filtered = data.devices.filter((d) => {
      if (this._filter === "active" && !d.active) return false;
      if (this._filter === "5g" && (!d.active || this._networkCategory(d) !== "5g")) return false;
      if (this._filter === "2g" && (!d.active || this._networkCategory(d) !== "2g")) return false;
      if (this._filter === "wired" && (!d.active || this._networkCategory(d) !== "wired")) return false;
      if (this._filter === "guest_iot" && (!d.active || this._networkCategory(d) !== "guest_iot")) return false;
      if (this._filter === "reserved" && !d.is_reserved) return false;

      if (q) {
        const hay = `${d.hostname} ${d.ip} ${d.mac} ${d.network} ${d.reservation_name || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    bodyEl.innerHTML = `
      <div class="summary-bar">
        <div class="summary-metrics">
          <span>LAN: <strong>${data.lanIp}</strong></span>
          <span>WAN: <strong>${data.wanIp}</strong></span>
          ${poolTxt}
          ${cpuTxt}
          ${memTxt}
        </div>
        <div>${data.firmware ? `FW: <strong>${data.firmware}</strong>` : ""}</div>
      </div>
      <div class="devices-grid" id="devices-grid"></div>
    `;

    const grid = bodyEl.querySelector("#devices-grid");
    if (filtered.length === 0) {
      grid.innerHTML = `<div class="empty-state">No devices found for the selected filter.</div>`;
      return;
    }

    grid.innerHTML = filtered
      .map((d) => {
        const cat = this._networkCategory(d);
        const icon = this._iconForDevice(d);
        const ipCopied = this._copiedText === d.ip;
        const macCopied = this._copiedText === d.mac;
        const sigText = d.signal !== null && d.signal !== undefined ? ` · ${d.signal} dBm` : "";

        return `
          <div class="device-card cat-${cat} ${d.active ? "online" : "offline"}" data-entity="${d.entityId || ""}">
            <div class="dev-top">
              <div class="dev-id">
                <div class="dev-icon"><ha-icon icon="${icon}"></ha-icon></div>
                <div class="dev-name" title="${this._escape(d.hostname)}">${this._escape(d.hostname)}</div>
              </div>
              <span class="net-badge cat-${cat}">${this._escape(d.network)}${sigText}</span>
            </div>
            <div class="dev-badges">
              <div class="dev-pills-left">
                <span class="mono-pill" data-copy="${this._escape(d.ip)}" title="Click to copy IP">
                  <span class="lbl">IP</span> ${ipCopied ? "Copied!" : this._escape(d.ip)}
                </span>
                <span class="mono-pill" data-copy="${this._escape(d.mac)}" title="Click to copy MAC">
                  <span class="lbl">MAC</span> ${macCopied ? "Copied!" : this._escape(d.mac)}
                </span>
              </div>
              <span class="dhcp-tag ${d.is_reserved ? "reserved" : ""}"
                    data-pin-mac="${this._escape(d.mac)}"
                    data-pin-ip="${this._escape(d.reserved_ip || d.ip)}"
                    data-pin-name="${this._escape(d.reservation_name || d.hostname)}"
                    data-pin-reserved="${d.is_reserved ? "1" : "0"}"
                    title="${d.is_reserved ? "Static IP Reserved (Click to edit/unpin)" : "Dynamic DHCP (Click to reserve static IP)"}">
                ${d.is_reserved ? "📌 Static" : "⏱️ Pin IP"}
              </span>
            </div>
          </div>
        `;
      })
      .join("");

    grid.querySelectorAll(".device-card").forEach((card) => {
      card.addEventListener("click", () => {
        const eid = card.dataset.entity;
        if (eid) this._openMoreInfo(eid);
      });
    });

    grid.querySelectorAll("[data-copy]").forEach((pill) => {
      pill.addEventListener("click", (e) => {
        this._copyValue(pill.dataset.copy, e);
      });
    });

    grid.querySelectorAll("[data-pin-mac]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._editingReservation = {
          mac: btn.dataset.pinMac,
          ip: btn.dataset.pinIp,
          hostname: btn.dataset.pinName,
          alreadyReserved: btn.dataset.pinReserved === "1",
          isNew: false,
        };
        this._render();
      });
    });
  }

  _renderDhcpManagerView(data, controlsEl, bodyEl, reservedCount) {
    const dynamicCount = data.devices.filter((d) => !d.is_reserved).length;
    const s = data.dhcpServer || {};

    controlsEl.innerHTML = `
      <div class="pill-group">
        <button class="btn" id="tab-clients">Clients (${data.devices.length})</button>
        <button class="btn" id="tab-flow">⚡ Traffic Flow</button>
        <button class="btn active" id="tab-dhcp">DHCP Manager (${reservedCount})</button>
      </div>
      <input type="text" class="search-input" id="dhcp-search" placeholder="Search IP, MAC, name..." value="${this._escape(this._search)}" />
      <div class="pill-group">
        <button class="btn ${this._dhcpFilter === "all" ? "active" : ""}" data-dfilter="all">All (${data.devices.length})</button>
        <button class="btn ${this._dhcpFilter === "reserved" ? "active" : ""}" data-dfilter="reserved">📌 Reserved (${reservedCount})</button>
        <button class="btn ${this._dhcpFilter === "dynamic" ? "active" : ""}" data-dfilter="dynamic">⏱️ Dynamic (${dynamicCount})</button>
      </div>
      <button class="btn primary" id="btn-new-res">+ Reserve IP</button>
      <button class="btn" id="btn-edit-pool">⚙️ Pool / DNS</button>
    `;

    controlsEl.querySelector("#tab-clients")?.addEventListener("click", () => {
      this._view = "clients";
      this._render();
    });

    controlsEl.querySelector("#tab-flow")?.addEventListener("click", () => {
      this._view = "flow";
      this._render();
    });

    const searchBox = controlsEl.querySelector("#dhcp-search");
    searchBox?.addEventListener("input", (e) => {
      this._search = e.target.value || "";
      const pos = e.target.selectionStart;
      this._render();
      const newBox = this.shadowRoot.getElementById("dhcp-search");
      if (newBox) {
        newBox.focus();
        newBox.setSelectionRange(pos, pos);
      }
    });

    controlsEl.querySelectorAll("[data-dfilter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._dhcpFilter = btn.dataset.dfilter;
        this._render();
      });
    });

    controlsEl.querySelector("#btn-new-res")?.addEventListener("click", () => {
      this._editingPool = false;
      this._editingReservation = {
        mac: "",
        ip: "192.168.1.",
        hostname: "",
        alreadyReserved: false,
        isNew: true,
      };
      this._render();
    });

    controlsEl.querySelector("#btn-edit-pool")?.addEventListener("click", () => {
      this._editingReservation = null;
      this._editingPool = !this._editingPool;
      this._render();
    });

    const q = this._search.trim().toLowerCase();
    const filtered = data.devices.filter((d) => {
      if (this._dhcpFilter === "reserved" && !d.is_reserved) return false;
      if (this._dhcpFilter === "dynamic" && d.is_reserved) return false;
      if (q) {
        const hay = `${d.hostname} ${d.ip} ${d.mac} ${d.reservation_name || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const poolRange = s.ip_start && s.ip_end ? `${s.ip_start} – ${s.ip_end}` : "192.168.1.100 – 192.168.1.199";
    const dnsText = [s.pri_dns, s.snd_dns].filter(Boolean).join(", ") || "Auto";

    bodyEl.innerHTML = `
      <div class="summary-bar">
        <div class="summary-metrics">
          <span>DHCP Server: <strong style="color:var(--be-online)">${s.enabled !== false ? "Enabled" : "Disabled"}</strong></span>
          <span>Pool: <strong>${poolRange}</strong></span>
          <span>Gateway: <strong>${s.gateway || data.lanIp}</strong></span>
          <span>Lease Time: <strong>${s.lease_time || "120"} min</strong></span>
          <span>DNS: <strong>${dnsText}</strong></span>
        </div>
        <div>
          <span>Static: <strong>${reservedCount}</strong> · Active Leases: <strong>${data.leasesCount || data.devices.filter((d) => d.active).length}</strong></span>
        </div>
      </div>
      <div class="devices-grid" id="dhcp-list"></div>
    `;

    const listEl = bodyEl.querySelector("#dhcp-list");
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No DHCP clients or reservations match your filter.</div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map((d) => {
        const cat = this._networkCategory(d);
        const icon = this._iconForDevice(d);
        const ipCopied = this._copiedText === d.ip;
        const macCopied = this._copiedText === d.mac;
        const leaseLabel = d.is_reserved
          ? `📌 Static`
          : `⏱️ ${this._escape(d.lease_time || "Dynamic")}`;

        return `
          <div class="device-card cat-${cat} ${d.active ? "online" : "offline"}">
            <div class="dev-top">
              <div class="dev-id">
                <div class="dev-icon"><ha-icon icon="${icon}"></ha-icon></div>
                <div class="dev-name" title="${this._escape(d.reservation_name || d.hostname)}">${this._escape(d.reservation_name || d.hostname)}</div>
              </div>
              <span class="dhcp-tag ${d.is_reserved ? "reserved" : ""}"
                    data-edit-mac="${this._escape(d.mac)}"
                    data-edit-ip="${this._escape(d.reserved_ip || d.ip)}"
                    data-edit-name="${this._escape(d.reservation_name || d.hostname)}"
                    data-edit-res="${d.is_reserved ? "1" : "0"}"
                    title="Click to edit or reserve static IP">
                ${leaseLabel} ✏️
              </span>
            </div>
            <div class="dev-badges">
              <div class="dev-pills-left">
                <span class="mono-pill" data-copy="${this._escape(d.ip)}" title="Click to copy IP">
                  <span class="lbl">IP</span> ${ipCopied ? "Copied!" : this._escape(d.ip)}
                </span>
                <span class="mono-pill" data-copy="${this._escape(d.mac)}" title="Click to copy MAC">
                  <span class="lbl">MAC</span> ${macCopied ? "Copied!" : this._escape(d.mac)}
                </span>
              </div>
              ${
                d.is_reserved
                  ? `<span class="dhcp-tag" style="color:var(--be-danger);border-color:color-mix(in srgb, var(--be-danger) 40%, transparent)" data-del-mac="${this._escape(d.mac)}" title="Remove static reservation">🗑️</span>`
                  : `<span class="net-badge cat-${cat}">${this._escape(d.band)}</span>`
              }
            </div>
          </div>
        `;
      })
      .join("");

    listEl.querySelectorAll("[data-copy]").forEach((pill) => {
      pill.addEventListener("click", (e) => {
        this._copyValue(pill.dataset.copy, e);
      });
    });

    listEl.querySelectorAll("[data-edit-mac]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._editingPool = false;
        this._editingReservation = {
          mac: btn.dataset.editMac,
          ip: btn.dataset.editIp,
          hostname: btn.dataset.editName,
          alreadyReserved: btn.dataset.editRes === "1",
          isNew: false,
        };
        this._render();
      });
    });

    listEl.querySelectorAll("[data-del-mac]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._deleteReservation(btn.dataset.delMac);
      });
    });
  }

  _fmtLiveSpeed(bytesPerSec) {
    const bps = Math.max(0, Number(bytesPerSec) || 0);
    if (bps === 0) return "0 KB/s";
    if (bps >= 1048576) {
      return `${(bps / 1048576).toFixed(1)} MB/s`;
    }
    if (bps >= 1024) {
      return `${(bps / 1024).toFixed(1)} KB/s`;
    }
    return `${Math.round(bps)} B/s`;
  }

  _fmtPhySpeed(kbps) {
    const k = Math.max(0, Number(kbps) || 0);
    if (k <= 0) return "0 Mbps";
    const mbps = k / 1000;
    if (mbps >= 1000) {
      return `${(mbps / 1000).toFixed(2)} Gbps`;
    }
    return `${Math.round(mbps)} Mbps`;
  }

  _fmtBytes(bytes) {
    const b = Math.max(0, Number(bytes) || 0);
    if (b <= 0) return "0 MB";
    if (b >= 1099511627776) {
      return `${(b / 1099511627776).toFixed(2)} TB`;
    }
    if (b >= 1073741824) {
      return `${(b / 1073741824).toFixed(1)} GB`;
    }
    if (b >= 1048576) {
      return `${(b / 1048576).toFixed(1)} MB`;
    }
    return `${Math.round(b / 1024)} KB`;
  }

  _flowDuration(val, maxVal) {
    const v = Math.max(0, Number(val) || 0);
    if (v <= 0) return 0;
    const norm = Math.min(1, v / Math.max(1, maxVal));
    return (3.8 - norm * 2.7).toFixed(2);
  }

  _deviceMetrics(d) {
    const liveRx = Math.max(0, Number(d.down_speed) || 0);
    const liveTx = Math.max(0, Number(d.up_speed) || 0);
    const isWired = this._networkCategory(d) === "wired";
    // TP-Link BE230 reports tx_rate / rx_rate in kbps for Wi-Fi; wired ports default to 1000000 kbps (1 Gbps)
    const phyRx = d.rx_rate ? Number(d.rx_rate) : isWired && d.active ? 1000000 : 0;
    const phyTx = d.tx_rate ? Number(d.tx_rate) : isWired && d.active ? 1000000 : 0;
    const totalBytes = Math.max(0, Number(d.traffic_usage) || 0);
    const pktsRx = Math.max(0, Number(d.packets_received) || 0);
    const pktsTx = Math.max(0, Number(d.packets_sent) || 0);
    const pktRatioRx = pktsRx + pktsTx > 0 ? pktsRx / (pktsRx + pktsTx) : 0.65;
    return {
      liveRx,
      liveTx,
      liveTotal: liveRx + liveTx,
      phyRx,
      phyTx,
      phyTotal: phyRx + phyTx,
      totalBytes,
      estBytesRx: totalBytes * pktRatioRx,
      estBytesTx: totalBytes * (1 - pktRatioRx),
      pktsRx,
      pktsTx,
    };
  }

  _renderFlowView(data, controlsEl, bodyEl, subtitleEl, reservedCount) {
    const activeDevices = data.devices.filter((d) => d.active);
    const enriched = activeDevices.map((d) => ({
      ...d,
      cat: this._networkCategory(d),
      m: this._deviceMetrics(d),
    }));

    const totalLiveRx = enriched.reduce((s, d) => s + d.m.liveRx, 0);
    const totalLiveTx = enriched.reduce((s, d) => s + d.m.liveTx, 0);
    const totalLive = totalLiveRx + totalLiveTx;
    const totalTraffic = enriched.reduce((s, d) => s + d.m.totalBytes, 0);

    // Determine effective metric mode ("live" | "phy" | "traffic")
    let mode = this._flowMetric;
    if (mode === "auto") {
      mode = totalLive > 512 ? "live" : "phy";
    }

    const metricScore = (d) => {
      if (mode === "live") {
        // Primary sort by live throughput, tie-break by PHY link & traffic
        return d.m.liveTotal > 0 ? d.m.liveTotal * 1000000 + d.m.phyTotal : d.m.phyTotal * 0.001;
      }
      if (mode === "traffic") {
        return d.m.totalBytes;
      }
      return d.m.phyTotal;
    };

    subtitleEl.textContent = this._diagramOnly
      ? `↓ ${this._fmtLiveSpeed(totalLiveRx)} · ↑ ${this._fmtLiveSpeed(totalLiveTx)} · Σ ${this._fmtBytes(totalTraffic)} · ${activeDevices.length} Online`
      : `Live: ↓ ${this._fmtLiveSpeed(totalLiveRx)} · ↑ ${this._fmtLiveSpeed(totalLiveTx)} · Session Traffic: ${this._fmtBytes(totalTraffic)} · ${activeDevices.length} Active Clients`;

    controlsEl.innerHTML = `
      ${
        !this._flowOnly
          ? `
        <div class="pill-group">
          <button class="btn" id="tab-clients">Clients (${data.devices.length})</button>
          <button class="btn active" id="tab-flow">⚡ Traffic Flow</button>
          <button class="btn" id="tab-dhcp">DHCP Manager (${reservedCount})</button>
        </div>
      `
          : ""
      }
      <div class="pill-group">
        <button class="btn ${mode === "live" ? "active" : ""}" data-fmetric="live" title="Real-time RX/TX speed">⚡ ${this._diagramOnly ? "Live" : "Live RX/TX"}</button>
        <button class="btn ${mode === "phy" ? "active" : ""}" data-fmetric="phy" title="Negotiated Wi-Fi / Ethernet Link Capacity (Mbps)">📶 ${this._diagramOnly ? "Link" : "Link Rate"}</button>
        <button class="btn ${mode === "traffic" ? "active" : ""}" data-fmetric="traffic" title="Cumulative Data Usage (GB)">📊 ${this._diagramOnly ? "Data" : "Total Data"}</button>
      </div>
      ${
        this._diagramOnly
          ? `<div class="pill-group"><button class="btn active" id="btn-flow-detail" title="Go to Network tab">Details →</button></div>`
          : `<button class="btn ${this._compact ? "active" : ""}" id="flow-compact-btn">Compact</button>`
      }
    `;

    controlsEl.querySelector("#btn-flow-detail")?.addEventListener("click", () => {
      this._navigate(this._config.detail_path || "/dashboard-tsentr-v2/network");
    });
    controlsEl.querySelector("#tab-clients")?.addEventListener("click", () => {
      this._view = "clients";
      this._render();
    });
    controlsEl.querySelector("#tab-dhcp")?.addEventListener("click", () => {
      this._view = "dhcp";
      this._render();
    });
    controlsEl.querySelectorAll("[data-fmetric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._flowMetric = btn.dataset.fmetric;
        this._render();
      });
    });
    controlsEl.querySelector("#flow-compact-btn")?.addEventListener("click", () => {
      this._compact = !this._compact;
      this._render();
    });

    // Aggregate per band ("5g", "2g", "wired", "guest_iot")
    const bandDefs = [
      { id: "5g", label: "5GHz / MLO", icon: "mdi:wifi-star", color: "var(--be-5g)", y: 55 },
      { id: "2g", label: "2.4GHz", icon: "mdi:wifi", color: "var(--be-2g)", y: 128 },
      { id: "wired", label: "Ethernet LAN", icon: "mdi:lan-connect", color: "var(--be-lan)", y: 201 },
      { id: "guest_iot", label: "IoT / Guest", icon: "mdi:access-point-network", color: "var(--be-guest)", y: 268 },
    ];

    const bands = bandDefs.map((b) => {
      const devs = enriched.filter((d) => d.cat === b.id);
      const rxLive = devs.reduce((s, d) => s + d.m.liveRx, 0);
      const txLive = devs.reduce((s, d) => s + d.m.liveTx, 0);
      const rxPhy = devs.reduce((s, d) => s + d.m.phyRx, 0);
      const txPhy = devs.reduce((s, d) => s + d.m.phyTx, 0);
      const bytes = devs.reduce((s, d) => s + d.m.totalBytes, 0);
      const val =
        mode === "live"
          ? rxLive + txLive > 0
            ? rxLive + txLive
            : devs.length * 1024
          : mode === "traffic"
          ? bytes
          : rxPhy + txPhy;
      const mainLabel =
        mode === "live"
          ? rxLive + txLive > 0
            ? this._fmtLiveSpeed(rxLive + txLive)
            : `${devs.length} Dev`
          : mode === "traffic"
          ? this._fmtBytes(bytes)
          : this._fmtPhySpeed(Math.round((rxPhy + txPhy) / 2));
      const subLabel =
        mode === "live" && rxLive + txLive > 0
          ? `↓${this._fmtLiveSpeed(rxLive)}`
          : `${devs.length} online`;
      return {
        ...b,
        devs,
        count: devs.length,
        val: devs.length > 0 ? Math.max(1, val) : 0,
        mainLabel,
        subLabel,
      };
    });

    const maxBandVal = Math.max(1, ...bands.map((b) => b.val));

    // Top 4 active devices for the right-hand side of the flow topology
    const sortedDevices = [...enriched].sort((a, b) => metricScore(b) - metricScore(a));
    const top4 = sortedDevices.slice(0, 4);
    const top4Y = [52, 124, 198, 268];
    const maxTopVal = Math.max(
      1,
      ...top4.map((d) =>
        mode === "live"
          ? Math.max(1024, d.m.liveTotal)
          : mode === "traffic"
          ? d.m.totalBytes
          : d.m.phyTotal
      )
    );

    const bandYMap = { "5g": 55, "2g": 128, wired: 201, guest_iot: 268 };
    const bandColorMap = {
      "5g": "var(--be-5g)",
      "2g": "var(--be-2g)",
      wired: "var(--be-lan)",
      guest_iot: "var(--be-guest)",
    };

    // Build SVG paths & animated particles
    // Coordinates in viewBox="0 0 560 310":
    // WAN node: (58, 160) -> Router Hub: (185, 160) -> Band nodes: (342, b.y) -> Top 4 Device nodes: (498, top4Y[i])
    const wanActive = activeDevices.length > 0;
    const wanDur = this._flowDuration(maxBandVal, maxBandVal);

    const svgPaths = [];
    // 1. WAN -> BE230 Hub
    svgPaths.push(`
      <path class="flow-path ${wanActive ? "" : "inactive"}" style="stroke: var(--be-accent);" d="M 58 160 L 185 160" />
      ${
        wanActive
          ? `<circle class="flow-dot" r="3.6" style="fill: var(--be-accent);">
               <animateMotion dur="${wanDur}s" repeatCount="indefinite" path="M 58 160 L 185 160" />
             </circle>
             <circle class="flow-dot" r="2.6" style="fill: var(--be-online); opacity: 0.85;">
               <animateMotion dur="${(Number(wanDur) * 1.25).toFixed(2)}s" repeatCount="indefinite" path="M 185 160 L 58 160" />
             </circle>`
          : ""
      }
    `);

    // 2. BE230 Hub -> Band Nodes
    for (const b of bands) {
      const pathD = `M 185 160 C 255 160, 275 ${b.y}, 342 ${b.y}`;
      const revPathD = `M 342 ${b.y} C 275 ${b.y}, 255 160, 185 160`;
      const isAct = b.count > 0;
      const dur = this._flowDuration(b.val, maxBandVal);
      svgPaths.push(`
        <path class="flow-path ${isAct ? "" : "inactive"}" style="stroke: ${b.color};" d="${pathD}" />
        ${
          isAct
            ? `<circle class="flow-dot" r="3.2" style="fill: ${b.color};">
                 <animateMotion dur="${dur}s" repeatCount="indefinite" path="${pathD}" />
               </circle>
               <circle class="flow-dot" r="2.2" style="fill: ${b.color}; opacity: 0.65;">
                 <animateMotion dur="${(Number(dur) * 1.35).toFixed(2)}s" repeatCount="indefinite" path="${revPathD}" />
               </circle>`
            : ""
        }
      `);
    }

    // 3. Band Nodes -> Top 4 Active Client Nodes
    top4.forEach((d, idx) => {
      const sy = bandYMap[d.cat] || 128;
      const ty = top4Y[idx];
      const col = bandColorMap[d.cat] || "var(--be-5g)";
      const pathD = `M 342 ${sy} C 415 ${sy}, 430 ${ty}, 498 ${ty}`;
      const rawVal =
        mode === "live"
          ? Math.max(1024, d.m.liveTotal)
          : mode === "traffic"
          ? Math.max(1, d.m.totalBytes)
          : Math.max(1, d.m.phyTotal);
      const dur = this._flowDuration(rawVal, maxTopVal);
      svgPaths.push(`
        <path class="flow-path" style="stroke: ${col}; opacity: 0.42;" d="${pathD}" />
        <circle class="flow-dot" r="2.9" style="fill: ${col};">
          <animateMotion dur="${dur}s" repeatCount="indefinite" path="${pathD}" />
        </circle>
      `);
    });

    // HTML Overlay Nodes for SVG Diagram
    const wanSub =
      totalLive > 0
        ? `↑ ${this._fmtLiveSpeed(totalLiveTx)}`
        : data.wanIp !== "--"
        ? data.wanIp
        : "Online";
    const wanVal =
      mode === "traffic"
        ? this._fmtBytes(totalTraffic)
        : totalLive > 0
        ? `↓ ${this._fmtLiveSpeed(totalLiveRx)}`
        : `${activeDevices.length} Clients`;

    const bandNodesHtml = bands
      .map((b) => {
        const leftPct = ((342 / 560) * 100).toFixed(1);
        const topPct = ((b.y / 310) * 100).toFixed(1);
        const isSel = this._flowBandFilter === b.id;
        return `
          <div class="flow-node" data-fband="${b.id}" style="left: ${leftPct}%; top: ${topPct}%;" title="Click to filter ${b.label} devices">
            <div class="flow-circle ${b.count === 0 ? "inactive" : ""} ${isSel ? "selected" : ""}" style="--node-color: ${b.color};">
              <ha-icon icon="${b.icon}"></ha-icon>
              <span class="flow-val">${b.mainLabel}</span>
              <span class="flow-sub">${b.subLabel}</span>
            </div>
            <span class="flow-node-label bottom">${b.label}</span>
          </div>
        `;
      })
      .join("");

    const top4NodesHtml = top4
      .map((d, idx) => {
        const leftPct = ((498 / 560) * 100).toFixed(1);
        const topPct = ((top4Y[idx] / 310) * 100).toFixed(1);
        const col = bandColorMap[d.cat] || "var(--be-5g)";
        const icon = this._iconForDevice(d);
        const valTxt =
          mode === "live"
            ? d.m.liveTotal > 0
              ? this._fmtLiveSpeed(d.m.liveTotal)
              : this._fmtPhySpeed(d.m.phyRx)
            : mode === "traffic"
            ? this._fmtBytes(d.m.totalBytes)
            : this._fmtPhySpeed(d.m.phyRx);
        const subTxt =
          mode === "live" && d.m.liveTotal > 0
            ? `↑${this._fmtLiveSpeed(d.m.liveTx)}`
            : d.ip !== "--"
            ? `.${d.ip.split(".").slice(-1)[0]}`
            : d.band;
        return `
          <div class="flow-node" data-fentity="${d.entityId || ""}" style="left: ${leftPct}%; top: ${topPct}%;" title="${this._escape(d.hostname)} (${this._escape(d.ip)})">
            <div class="flow-circle sm" style="--node-color: ${col};">
              <ha-icon icon="${icon}"></ha-icon>
              <span class="flow-val">${valTxt}</span>
              <span class="flow-sub">${subTxt}</span>
            </div>
            <span class="flow-node-label bottom">${this._escape(d.hostname)}</span>
          </div>
        `;
      })
      .join("");

    // Proportional Breakdown Bar
    const totalBandWeight = Math.max(1, bands.reduce((s, b) => s + (b.count > 0 ? b.val : 0), 0));
    const distBarHtml = bands
      .filter((b) => b.count > 0)
      .map((b) => {
        const pct = Math.max(2, (b.val / totalBandWeight) * 100);
        return `<div class="dist-seg" style="width:${pct.toFixed(1)}%; background:${b.color};" title="${b.label}: ${b.mainLabel} (${Math.round(pct)}%)"></div>`;
      })
      .join("");

    const distLegendHtml = bands
      .map((b) => {
        const pct = b.count > 0 ? Math.round((b.val / totalBandWeight) * 100) : 0;
        return `
          <div class="dist-item" data-fband="${b.id}" title="Click to filter by ${b.label}">
            <span class="dist-dot" style="background:${b.color};"></span>
            ${b.label}: <strong>${b.mainLabel}</strong> (${pct}%)
          </div>
        `;
      })
      .join("");

    // Filtered list of ALL active devices for the live TX/RX matrix
    const displayedDevices = sortedDevices.filter((d) =>
      this._flowBandFilter === "all" ? true : d.cat === this._flowBandFilter
    );

    // Compute max RX / TX across displayed devices for smooth relative bar scaling
    const maxRxVal = Math.max(
      1,
      ...displayedDevices.map((d) =>
        mode === "live"
          ? d.m.liveRx > 0
            ? d.m.liveRx
            : d.m.phyRx
          : mode === "traffic"
          ? d.m.estBytesRx
          : d.m.phyRx
      )
    );
    const maxTxVal = Math.max(
      1,
      ...displayedDevices.map((d) =>
        mode === "live"
          ? d.m.liveTx > 0
            ? d.m.liveTx
            : d.m.phyTx
          : mode === "traffic"
          ? d.m.estBytesTx
          : d.m.phyTx
      )
    );

    const devicesMatrixHtml = displayedDevices
      .map((d) => {
        const icon = this._iconForDevice(d);
        const rxVal =
          mode === "live"
            ? d.m.liveRx > 0
              ? d.m.liveRx
              : d.m.phyRx * 0.25
            : mode === "traffic"
            ? d.m.estBytesRx
            : d.m.phyRx;
        const txVal =
          mode === "live"
            ? d.m.liveTx > 0
              ? d.m.liveTx
              : d.m.phyTx * 0.25
            : mode === "traffic"
            ? d.m.estBytesTx
            : d.m.phyTx;

        const rxPct = Math.min(100, Math.max(4, Math.round((rxVal / maxRxVal) * 100)));
        const txPct = Math.min(100, Math.max(4, Math.round((txVal / maxTxVal) * 100)));

        const rxText =
          mode === "live"
            ? d.m.liveRx > 0
              ? this._fmtLiveSpeed(d.m.liveRx)
              : this._fmtPhySpeed(d.m.phyRx)
            : mode === "traffic"
            ? this._fmtBytes(d.m.estBytesRx)
            : this._fmtPhySpeed(d.m.phyRx);

        const txText =
          mode === "live"
            ? d.m.liveTx > 0
              ? this._fmtLiveSpeed(d.m.liveTx)
              : this._fmtPhySpeed(d.m.phyTx)
            : mode === "traffic"
            ? this._fmtBytes(d.m.estBytesTx)
            : this._fmtPhySpeed(d.m.phyTx);

        const sigText = d.signal !== null && d.signal !== undefined ? `${d.signal} dBm` : d.band;
        const totalDataTxt = d.m.totalBytes > 0 ? `Σ ${this._fmtBytes(d.m.totalBytes)}` : "Active";
        const phySummary =
          d.m.phyRx > 0
            ? `PHY ↓${this._fmtPhySpeed(d.m.phyRx)} ↑${this._fmtPhySpeed(d.m.phyTx)}`
            : "1 Gbps LAN";

        return `
          <div class="flow-dev-card cat-${d.cat}" data-fentity="${d.entityId || ""}">
            <div class="flow-dev-top">
              <div class="dev-id">
                <div class="dev-icon"><ha-icon icon="${icon}"></ha-icon></div>
                <div class="dev-name" title="${this._escape(d.hostname)}">${this._escape(d.hostname)}</div>
              </div>
              <span class="net-badge cat-${d.cat}">${this._escape(d.band)} · ${this._escape(sigText)}</span>
            </div>

            <div class="txrx-bars">
              <div class="txrx-row">
                <span class="txrx-lbl rx">↓ RX</span>
                <div class="txrx-track">
                  <div class="txrx-fill rx" style="width: ${rxPct}%;"></div>
                </div>
                <span class="txrx-val">${rxText}</span>
              </div>
              <div class="txrx-row">
                <span class="txrx-lbl tx">↑ TX</span>
                <div class="txrx-track">
                  <div class="txrx-fill tx" style="width: ${txPct}%;"></div>
                </div>
                <span class="txrx-val">${txText}</span>
              </div>
            </div>

            <div class="flow-dev-foot">
              <span class="flow-dev-meta">${this._escape(d.ip)}</span>
              <span>${phySummary}</span>
              <strong>${totalDataTxt}</strong>
            </div>
          </div>
        `;
      })
      .join("");

    bodyEl.innerHTML = `
      <div class="flow-diagram-wrap">
        <svg class="flow-svg" viewBox="0 0 560 310" preserveAspectRatio="none">
          ${svgPaths.join("")}
        </svg>

        <!-- WAN Node -->
        <div class="flow-node" style="left: 10.4%; top: 51.6%;" title="WAN IP: ${this._escape(data.wanIp)}">
          <span class="flow-node-label">WAN / ISP</span>
          <div class="flow-circle" style="--node-color: var(--be-accent);">
            <ha-icon icon="mdi:earth"></ha-icon>
            <span class="flow-val">${wanVal}</span>
            <span class="flow-sub">${this._escape(wanSub)}</span>
          </div>
        </div>

        <!-- Central BE230 Router Hub -->
        <div class="flow-node" id="flow-hub-node" style="left: 33.0%; top: 51.6%;" title="Click to show all bands (${this._escape(data.lanIp)})">
          <span class="flow-node-label">Archer BE230</span>
          <div class="flow-circle lg ${this._flowBandFilter === "all" ? "selected" : ""}" style="--node-color: var(--be-online);">
            <span class="flow-sub">CPU ${data.cpuUsage ?? 0}%</span>
            <ha-icon icon="mdi:router-wireless"></ha-icon>
            <span class="flow-val">${activeDevices.length} Online</span>
          </div>
          <span class="flow-node-label bottom">${this._escape(data.lanIp)}</span>
        </div>

        <!-- 4 Band Nodes -->
        ${bandNodesHtml}

        <!-- Top 4 Active Client Nodes -->
        ${top4NodesHtml}
      </div>

      <div class="dist-section" style="${this._diagramOnly ? "margin-bottom:0;" : ""}">
        <div class="dist-bar">${distBarHtml}</div>
        <div class="dist-legend">${distLegendHtml}</div>
      </div>

      ${
        !this._diagramOnly
          ? `
        <div class="flow-matrix-header">
          <span>Active Devices TX / RX Distribution (${displayedDevices.length} of ${activeDevices.length})</span>
          ${
            this._flowBandFilter !== "all"
              ? `<button class="btn active" id="flow-reset-band">Showing: ${this._flowBandFilter.toUpperCase()} ✕</button>`
              : `<span>Sorted by ${mode === "live" ? "Live Throughput" : mode === "traffic" ? "Total Traffic" : "Link Rate (Mbps)"}</span>`
          }
        </div>

        <div class="flow-devices-grid">
          ${devicesMatrixHtml || `<div class="empty-state">No active devices in this band.</div>`}
        </div>
      `
          : ""
      }
    `;

    bodyEl.querySelector("#flow-hub-node")?.addEventListener("click", () => {
      if (this._diagramOnly) {
        this._navigate(this._config.detail_path || "/dashboard-tsentr-v2/network");
        return;
      }
      this._flowBandFilter = "all";
      this._render();
    });

    bodyEl.querySelector("#flow-reset-band")?.addEventListener("click", () => {
      this._flowBandFilter = "all";
      this._render();
    });

    bodyEl.querySelectorAll("[data-fband]").forEach((el) => {
      el.addEventListener("click", () => {
        if (this._diagramOnly) {
          this._navigate(this._config.detail_path || "/dashboard-tsentr-v2/network");
          return;
        }
        const b = el.dataset.fband;
        this._flowBandFilter = this._flowBandFilter === b ? "all" : b;
        this._render();
      });
    });

    bodyEl.querySelectorAll("[data-fentity]").forEach((el) => {
      el.addEventListener("click", () => {
        const eid = el.dataset.fentity;
        if (eid) this._openMoreInfo(eid);
      });
    });
  }

  _escape(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

class TplinkBe230FlowCard extends TplinkBe230Card {
  static getStubConfig() {
    return {
      title: "Network Traffic & TX/RX Flow",
      flow: true,
      compact: false,
    };
  }

  setConfig(config) {
    super.setConfig({
      title: "Network Traffic & TX/RX Flow",
      flow: true,
      ...config,
    });
  }
}

if (!customElements.get("tplink-be230-card")) {
  customElements.define("tplink-be230-card", TplinkBe230Card);
}
if (!customElements.get("tplink-be230-flow-card")) {
  customElements.define("tplink-be230-flow-card", TplinkBe230FlowCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "tplink-be230-card",
  name: "TP-Link Archer BE230 Network & DHCP Manager",
  description: "Displays connected devices, animated TX/RX traffic flow, and DHCP Reservation Manager for the TP-Link Archer BE230.",
  preview: true,
});
window.customCards.push({
  type: "tplink-be230-flow-card",
  name: "TP-Link Archer BE230 Live TX/RX Flow Card",
  description: "Animated hierarchical network flow diagram and real-time per-device TX/RX bandwidth distribution.",
  preview: true,
});
