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
    this._compact = false;
    this._view = "clients"; // clients | dhcp
    this._filter = "active"; // active | all | 5g | 2g | wired | guest_iot | reserved
    this._dhcpFilter = "all"; // all | reserved | dynamic
    this._ovBandFilter = "all";
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
      compact: false,
      default_view: "clients",
      show_offline: false,
      detail_path: "/dashboard-testdashboard/network",
      summary_entity: null,
      ...config,
    };
    this._overview = Boolean(this._config.overview);
    this._compact = Boolean(this._config.compact);
    this._view = this._config.default_view === "dhcp" ? "dhcp" : "clients";
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
          grid-template-columns: repeat(auto-fill, minmax(275px, 1fr));
          gap: 9px;
          max-height: 168px;
          overflow-y: auto;
          padding-right: 4px;
        }
        ha-card.compact .devices-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(275px, 1fr));
          max-height: 110px;
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

    // Full Detailed Mode (Clients View OR DHCP Manager View)
    subtitleEl.textContent = `${activeCount} connected · ${reservedCount} static DHCP · 5GHz: ${count5g} · 2.4GHz: ${count2g} · IoT: ${countGuestIot} · Wired: ${countWired}`;

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

  _escape(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

if (!customElements.get("tplink-be230-card")) {
  customElements.define("tplink-be230-card", TplinkBe230Card);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "tplink-be230-card",
  name: "TP-Link Archer BE230 Network & DHCP Manager",
  description: "Displays connected devices and provides a full DHCP Reservation & Pool Manager for the TP-Link Archer BE230.",
  preview: true,
});
