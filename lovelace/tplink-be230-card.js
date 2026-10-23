/**
 * TP-Link Archer BE230 Network Card - Theme-Aware Lovelace Web Component
 * Supports both a compact Front-Page Overview mode (`overview: true`)
 * and a full Network Detail mode (`overview: false`) with IP, MAC, and Network badges.
 */
class TplinkBe230Card extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._overview = false;
    this._compact = false;
    this._filter = "active"; // active | all | 5g | 2g | wired | guest_iot
    this._ovBandFilter = "all"; // all | 5g | 2g | wired | guest_iot
    this._search = "";
    this._copiedText = null;
  }

  static getStubConfig() {
    return {
      title: "TP-Link Archer BE230",
      overview: false,
      compact: false,
      show_offline: false,
      detail_path: "/dashboard-testdashboard/network",
    };
  }

  setConfig(config) {
    this._config = {
      title: "TP-Link Archer BE230",
      overview: false,
      compact: false,
      show_offline: false,
      detail_path: "/dashboard-testdashboard/network",
      summary_entity: null,
      ...config,
    };
    this._overview = Boolean(this._config.overview);
    this._compact = Boolean(this._config.compact);
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

  _discoverData() {
    const states = this._hass?.states || {};
    const trackerByMac = new Map();
    let summarySensor = null;

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
          break;
        }
      }
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

      trackerByMac.set(mac, {
        entityId: eid,
        hostname: a.hostname || a.friendly_name || eid.replace("device_tracker.", ""),
        ip: a.ip || a.ip_address || "--",
        mac,
        network: a.network || this._labelForType(a.network_type),
        network_type: a.network_type || "unknown",
        band: a.band || this._bandForType(a.network_type),
        active: st.state === "home" || Boolean(a.active),
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
        trackerByMac.set(mac, {
          entityId: existing?.entityId || null,
          hostname: d.hostname || existing?.hostname || `Device ${mac.slice(-8)}`,
          ip: d.ip || existing?.ip || "--",
          mac,
          network: d.network || existing?.network || this._labelForType(d.network_type),
          network_type: d.network_type || existing?.network_type || "unknown",
          band: d.band || existing?.band || this._bandForType(d.network_type),
          active: d.active !== undefined ? Boolean(d.active) : Boolean(existing?.active),
          signal: d.signal ?? existing?.signal ?? null,
          packets_sent: d.packets_sent ?? existing?.packets_sent ?? null,
          packets_received: d.packets_received ?? existing?.packets_received ?? null,
          down_speed: d.down_speed ?? existing?.down_speed ?? null,
          up_speed: d.up_speed ?? existing?.up_speed ?? null,
          last_seen: d.last_seen ?? existing?.last_seen ?? null,
        });
      }
    }

    const devices = Array.from(trackerByMac.values()).sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return this._ipToInt(a.ip) - this._ipToInt(b.ip);
    });

    const attrs = summarySensor?.attributes || {};
    return {
      summaryEntityId: summarySensor?.entity_id || null,
      model: attrs.model || "Archer BE230",
      firmware: attrs.firmware_version || null,
      wanIp: attrs.wan_ip || "--",
      lanIp: attrs.lan_ip || "192.168.1.1",
      cpuUsage: attrs.cpu_usage ?? null,
      memUsage: attrs.mem_usage ?? null,
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
          width: 145px;
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

        /* Detailed Mode Styles */
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
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 9px;
        }
        ha-card.compact .devices-grid {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .device-card {
          background: var(--be-surface);
          border: 1px solid var(--be-divider);
          border-radius: 10px;
          padding: 10px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
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
          padding: 6px 10px;
          border-radius: 8px;
        }
        .dev-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-width: 0;
        }
        .dev-id {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .dev-icon {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          background: var(--be-input);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--be-text-primary);
          flex-shrink: 0;
        }
        .dev-icon ha-icon {
          --mdc-icon-size: 16px;
        }
        .dev-name {
          font-size: 0.82rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .net-badge {
          font-size: 0.66rem;
          font-weight: 700;
          padding: 2px 7px;
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
          gap: 6px;
          flex-wrap: wrap;
        }
        .mono-pill {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 0.69rem;
          padding: 2px 7px;
          border-radius: 6px;
          background: var(--be-input);
          border: 1px solid var(--be-divider);
          color: var(--be-text-primary);
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          transition: border-color 0.15s ease;
        }
        .mono-pill:hover {
          border-color: var(--be-accent);
        }
        .mono-pill .lbl {
          color: var(--be-text-secondary);
          font-size: 0.63rem;
          font-weight: 600;
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
        <div id="card-body"></div>
      </ha-card>
    `;
  }

  _render() {
    if (!this.shadowRoot || !this._hass) return;
    const data = this._discoverData();

    const cardRoot = this.shadowRoot.getElementById("card-root");
    cardRoot.classList.toggle("compact", this._compact && !this._overview);
    cardRoot.classList.toggle("overview", this._overview);

    this.shadowRoot.getElementById("card-title").textContent =
      this._config.title || `TP-Link ${data.model}`;

    const activeDevices = data.devices.filter((d) => d.active);
    const activeCount = activeDevices.length;
    const count5g = activeDevices.filter((d) => this._networkCategory(d) === "5g").length;
    const count2g = activeDevices.filter((d) => this._networkCategory(d) === "2g").length;
    const countWired = activeDevices.filter((d) => this._networkCategory(d) === "wired").length;
    const countGuestIot = activeDevices.filter((d) => this._networkCategory(d) === "guest_iot").length;

    const subtitleEl = this.shadowRoot.getElementById("card-subtitle");
    const controlsEl = this.shadowRoot.getElementById("header-controls");
    const bodyEl = this.shadowRoot.getElementById("card-body");

    if (this._overview) {
      subtitleEl.textContent = `${activeCount} active clients · LAN ${data.lanIp}`;
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
            <div class="kpi-val" style="font-size:0.76rem">${data.wanIp}</div>
            <div class="kpi-lbl">WAN IP</div>
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
                ${isCopied ? "Copied!" : shortIp}
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

    // Full Detailed Mode
    subtitleEl.textContent = `${activeCount} connected · 5GHz/MLO: ${count5g} · 2.4GHz: ${count2g} · IoT: ${countGuestIot} · Wired: ${countWired}`;

    const filters = [
      { id: "active", label: `Active (${activeCount})` },
      { id: "5g", label: `5GHz (${count5g})` },
      { id: "2g", label: `2.4GHz (${count2g})` },
      { id: "wired", label: `LAN (${countWired})` },
    ];
    if (countGuestIot > 0) {
      filters.push({ id: "guest_iot", label: `Guest/IoT (${countGuestIot})` });
    }
    filters.push({ id: "all", label: `All (${data.devices.length})` });

    controlsEl.innerHTML = `
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

    const q = this._search.trim().toLowerCase();
    const filtered = data.devices.filter((d) => {
      if (this._filter === "active" && !d.active) return false;
      if (this._filter === "5g" && (!d.active || this._networkCategory(d) !== "5g")) return false;
      if (this._filter === "2g" && (!d.active || this._networkCategory(d) !== "2g")) return false;
      if (this._filter === "wired" && (!d.active || this._networkCategory(d) !== "wired")) return false;
      if (this._filter === "guest_iot" && (!d.active || this._networkCategory(d) !== "guest_iot")) return false;

      if (q) {
        const hay = `${d.hostname} ${d.ip} ${d.mac} ${d.network}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    bodyEl.innerHTML = `
      <div class="summary-bar">
        <div class="summary-metrics">
          <span>LAN: <strong>${data.lanIp}</strong></span>
          <span>WAN: <strong>${data.wanIp}</strong></span>
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
              <span class="mono-pill" data-copy="${this._escape(d.ip)}" title="Click to copy IP">
                <span class="lbl">IP</span> ${ipCopied ? "Copied!" : this._escape(d.ip)}
              </span>
              <span class="mono-pill" data-copy="${this._escape(d.mac)}" title="Click to copy MAC">
                <span class="lbl">MAC</span> ${macCopied ? "Copied!" : this._escape(d.mac)}
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
  name: "TP-Link Archer BE230 Devices Card",
  description: "Displays all devices connected to the TP-Link Archer BE230 (Overview or Detailed mode).",
  preview: true,
});
