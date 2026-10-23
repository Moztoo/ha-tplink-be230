# ha-tplink-be230

Complete **Home Assistant Custom Integration**, **Lovelace Web Component Card**, and **Python CLI** for the **TP-Link Archer BE230** Wi-Fi 7 router, powered by [`tplinkrouterc6u`](https://pypi.org/project/tplinkrouterc6u/).

---

## Repository Structure

```text
ha-tplink-be230/
├── custom_components/
│   └── tplink_be230/              # Home Assistant Custom Integration
│       ├── __init__.py
│       ├── manifest.json
│       ├── const.py
│       ├── config_flow.py         # UI Setup, OptionsFlow & Reauth Flow
│       ├── coordinator.py         # Local polling & dynamic client discovery
│       ├── device_tracker.py      # Creates an enabled entity per connected client
│       ├── sensor.py              # Router telemetry & client summary sensors
│       ├── button.py              # Router reboot button entity
│       ├── strings.json
│       └── translations/
│           ├── en.json
│           └── es.json
├── lovelace/
│   └── tplink-be230-card.js       # Lovelace Custom Card (custom:tplink-be230-card)
├── be230.py                       # Terminal CLI administration tool
├── requirements.txt
├── .env.example
├── hacs.json
└── README.md
```

---

## 1. Home Assistant Integration (`tplink_be230`)

### Features
* **100% UI Configuration (Config Flow & Options Flow):**
  Configure the **Router Host/IP** (`http://192.168.1.1`), **Local Admin Password**, and **Polling Interval** directly from the Home Assistant UI. Update your password anytime from *Settings → Devices & Services → TP-Link Archer BE230 → Configure*.
* **Automatic Client Identity Creation (`device_tracker`):**
  Every connected client is automatically discovered and enabled by default as a `device_tracker.<hostname_or_mac>` entity (`home` / `not_home`) with rich state attributes:
  * `ip`: IPv4 address (`192.168.1.x`)
  * `mac`: Normalized MAC address (`AA:BB:CC:DD:EE:FF`)
  * `hostname`: Device hostname
  * `network`: Connected network label (`Wi-Fi 5GHz`, `Wi-Fi 2.4GHz`, `Wi-Fi 7 MLO`, `Ethernet (LAN)`, `Guest 5GHz`, `Guest 2.4GHz`, `IoT 2.4GHz`, `IoT 5GHz`)
  * `network_type`: Raw network identifier (`host_5g`, `host_2g`, `host_mlo`, `wired`, `guest_5g`, `iot_2g`, etc.)
  * `band`: Frequency band (`5GHz`, `2.4GHz`, `6GHz`, `MLO`, `LAN`)
  * `signal`, `packets_sent`, `packets_received`, `down_speed`, `up_speed`, `last_seen`
* **Router Telemetry Sensors & Controls:**
  * Connected Devices count & full device list attribute
  * WAN IPv4 & LAN IPv4 sensors
  * CPU Usage (`%`) & Memory Usage (`%`) sensors
  * Wi-Fi Clients & Wired Clients count sensors
  * Router Reboot button entity

### Installation

1. Copy `custom_components/tplink_be230` to your Home Assistant `/config/custom_components/` directory:
   ```bash
   cp -r custom_components/tplink_be230 /config/custom_components/
   ```
2. Restart Home Assistant.
3. Navigate to **Settings → Devices & Services → Add Integration** and search for **TP-Link Archer BE230**.
4. Enter your router IP (`http://192.168.1.1`), local admin password, and desired scan interval (`30` seconds).

---

## 2. Lovelace Custom Card (`custom:tplink-be230-card`)

The included [`lovelace/tplink-be230-card.js`](./lovelace/tplink-be230-card.js) is a theme-aware Web Component that automatically discovers all `device_tracker` entities created by the integration. It supports both a compact **Front-Page Overview mode (`overview: true`)** and a **Full Detailed mode (`overview: false`)**.

### Card Features
* **Overview Mode (`overview: true`):**
  * 4 KPI summary boxes (`Connected`, `CPU %`, `RAM %`, `Static IPs`).
  * Proportional multi-band distribution bar (`5GHz`, `2.4GHz`, `IoT`, `LAN`) and interactive band filter pills.
  * 2-column compact client chips with click-to-copy IP, `📌` indicator for static DHCP reservations, and a `Details →` navigation button.
* **Detailed Mode (`overview: false`):**
  * Full device cards showing **Hostname**, **IP** (click to copy), **MAC** (click to copy), **Connected Network Badge**, and a **1-click `📌 Static` / `⏱️ Pin IP` button** to reserve or edit any device's static IP on the fly.
  * Instant search bar (by name, IP, or MAC), network filter tabs (`Active`, `5GHz`, `2.4GHz`, `LAN`, `Guest/IoT`, `📌 Static`, `All`), and `Compact` / `Grid` toggle.
* **Built-In DHCP Manager (`DHCP Manager` header tab or `default_view: "dhcp"`):**
  * View & edit **DHCP Server Pool & DNS settings** (`Start IP`, `End IP`, `Lease Time`, `Default Gateway`, `Primary & Secondary DNS`) directly from Home Assistant.
  * Unified table of **Static IP Reservations (`📌`)** and **Active DHCP Leases (`⏱️`)** with remaining lease time.
  * **1-Click Reserve / Edit / Unreserve:** Lock any dynamic client's current IP or assign a custom IPv4 address and hostname without opening the router's web UI.
  * Powered by Home Assistant services:
    * `tplink_be230.add_dhcp_reservation` (`mac`, `ip`, `hostname`, `enable`)
    * `tplink_be230.delete_dhcp_reservation` (`mac`)
    * `tplink_be230.set_dhcp_server` (`enabled`, `ip_start`, `ip_end`, `lease_time`, `gateway`, `pri_dns`, `snd_dns`)

### Card Installation
1. Copy `lovelace/tplink-be230-card.js` to `/config/www/community/tplink-be230-card/tplink-be230-card.js`.
2. In **Settings → Dashboards → Resources**, add:
   * **URL:** `/local/community/tplink-be230-card/tplink-be230-card.js?v=1.1.1`
   * **Resource type:** `JavaScript Module`
3. Add the card to your dashboard:

```yaml
# Compact Overview Mode (for main/overview dashboard tab)
type: custom:tplink-be230-card
title: Archer BE230 Overview
overview: true
detail_path: /lovelace/network

# Full Detailed Mode (for dedicated Network tab)
type: custom:tplink-be230-card
title: TP-Link Archer BE230
overview: false
compact: false
show_offline: false
```

---

## 3. Terminal CLI (`be230.py`)

Manage and inspect the router directly from a Linux terminal:

```bash
cp .env.example .env
# Edit .env with your local router password (TPLINK_PASSWORD=...)

# Full status & connected devices
./be230.py

# Router status only
./be230.py status

# Connected client table only
./be230.py devices

# Detailed IPv4 WAN/LAN & DNS configuration
./be230.py ipv4

# DHCP Manager: view pool, static reservations & active leases
./be230.py dhcp status

# DHCP Manager: add/update or delete a static IP reservation
./be230.py dhcp reserve AA:BB:CC:DD:EE:FF 192.168.1.50 homelab-server
./be230.py dhcp delete AA:BB:CC:DD:EE:FF

# Toggle Wi-Fi bands (2g, 5g, guest2g, guest5g, iot2g, iot5g)
./be230.py wifi guest5g on

# Reboot the router
./be230.py reboot
```
