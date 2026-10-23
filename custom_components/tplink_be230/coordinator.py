"""DataUpdateCoordinator for the TP-Link Archer BE230 integration (including DHCP Manager)."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from json import dumps
import logging
from typing import Any
from urllib.parse import urlencode

from tplinkrouterc6u import TplinkRouterProvider

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    CONF_HOST,
    CONF_PASSWORD,
    CONF_SCAN_INTERVAL,
    CONF_USERNAME,
    CONF_VERIFY_SSL,
    DEFAULT_HOST,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_USERNAME,
    DEFAULT_VERIFY_SSL,
    DOMAIN,
    NETWORK_BANDS,
    NETWORK_LABELS,
    SIGNAL_NEW_DEVICE,
)

_LOGGER = logging.getLogger(__name__)


def normalize_mac(mac: str) -> str:
    """Normalize MAC address to uppercase colon-separated format (AA:BB:CC:DD:EE:FF)."""
    return mac.strip().upper().replace("-", ":")


class TplinkBE230Coordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator to poll TP-Link Archer BE230 router status, clients, and DHCP server."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the coordinator."""
        self.entry = entry
        self._router_lock = asyncio.Lock()
        self.known_devices: dict[str, dict[str, Any]] = {}
        self.registered_macs: set[str] = set()
        self.firmware_info: dict[str, str] = {
            "model": "Archer BE230",
            "hardware_version": "1.0",
            "firmware_version": "Unknown",
        }

        scan_interval = entry.options.get(
            CONF_SCAN_INTERVAL,
            entry.data.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
        )

        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_{entry.entry_id}",
            update_interval=timedelta(seconds=int(scan_interval)),
        )

    @property
    def host(self) -> str:
        """Return configured router host URL."""
        host = self.entry.options.get(
            CONF_HOST, self.entry.data.get(CONF_HOST, DEFAULT_HOST)
        ).strip()
        if not host.startswith("http://") and not host.startswith("https://"):
            host = f"http://{host}"
        return host

    @property
    def password(self) -> str:
        """Return configured router local password."""
        return self.entry.options.get(
            CONF_PASSWORD, self.entry.data.get(CONF_PASSWORD, "")
        )

    @property
    def username(self) -> str:
        """Return configured router username."""
        return self.entry.options.get(
            CONF_USERNAME, self.entry.data.get(CONF_USERNAME, DEFAULT_USERNAME)
        )

    @property
    def verify_ssl(self) -> bool:
        """Return whether to verify SSL certificates."""
        return bool(
            self.entry.options.get(
                CONF_VERIFY_SSL,
                self.entry.data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL),
            )
        )

    def _get_client(self):
        """Instantiate the tplinkrouterc6u client."""
        return TplinkRouterProvider.get_client(
            self.host,
            self.password,
            self.username,
            _LOGGER,
            self.verify_ssl,
        )

    def _poll_router_sync(self) -> dict[str, Any]:
        """Fetch firmware, status, DHCP settings, leases, and reservations in a single session."""
        router = self._get_client()
        try:
            router.authorize()
            fw = router.get_firmware()
            status = router.get_status()

            reservations = []
            try:
                reservations = router.get_ipv4_reservations()
            except Exception as err:
                _LOGGER.debug("Could not fetch IPv4 reservations: %s", err)

            leases = []
            try:
                leases = router.get_ipv4_dhcp_leases()
            except Exception as err:
                _LOGGER.debug("Could not fetch IPv4 DHCP leases: %s", err)

            dhcps_settings: dict[str, Any] = {}
            try:
                dhcps_url = getattr(router, "_url_ipv4_dhcps", "admin/dhcps?form=setting")
                raw_dhcps = router.request(dhcps_url, "operation=read")
                if isinstance(raw_dhcps, dict):
                    dhcps_settings = {
                        "enabled": str(raw_dhcps.get("enable", "on")).lower() in ("on", "true", "1"),
                        "ip_start": raw_dhcps.get("ipaddr_start", ""),
                        "ip_end": raw_dhcps.get("ipaddr_end", ""),
                        "lease_time": raw_dhcps.get("leasetime", ""),
                        "gateway": raw_dhcps.get("gateway", ""),
                        "pri_dns": raw_dhcps.get("pri_dns", ""),
                        "snd_dns": raw_dhcps.get("snd_dns", ""),
                        "domain": raw_dhcps.get("domain", ""),
                    }
            except Exception as err:
                _LOGGER.debug("Could not fetch DHCP server settings: %s", err)

            return {
                "firmware": fw,
                "status": status,
                "reservations": reservations,
                "leases": leases,
                "dhcps_settings": dhcps_settings,
            }
        finally:
            try:
                router.logout()
            except Exception:
                pass

    def reboot_router_sync(self) -> None:
        """Reboot the router synchronously in executor."""
        router = self._get_client()
        try:
            router.authorize()
            router.reboot()
        finally:
            try:
                router.logout()
            except Exception:
                pass

    def _add_or_update_reservation_sync(
        self, mac: str, ip: str, hostname: str = "", enable: bool = True
    ) -> None:
        """Add or update a DHCP address reservation on the router."""
        router = self._get_client()
        try:
            router.authorize()
            norm_mac = normalize_mac(mac)
            # Check if reservation for this MAC already exists; if so, remove first
            try:
                existing = router.get_ipv4_reservations()
                for r in existing:
                    if normalize_mac(r.macaddr) == norm_mac:
                        router.delete_ipv4_reservation(norm_mac)
                        break
            except Exception as err:
                _LOGGER.debug("Pre-check before reservation insert: %s", err)

            router.add_ipv4_reservation(norm_mac, ip.strip(), hostname.strip(), enable)
        finally:
            try:
                router.logout()
            except Exception:
                pass

    def _delete_reservation_sync(self, mac: str) -> None:
        """Delete a DHCP address reservation from the router."""
        router = self._get_client()
        try:
            router.authorize()
            router.delete_ipv4_reservation(normalize_mac(mac))
        finally:
            try:
                router.logout()
            except Exception:
                pass

    def _update_dhcp_server_sync(self, settings: dict[str, Any]) -> None:
        """Update DHCP server pool and DNS settings on the router."""
        router = self._get_client()
        try:
            router.authorize()
            dhcps_url = getattr(router, "_url_ipv4_dhcps", "admin/dhcps?form=setting")
            dhcps_write_url = getattr(router, "_url_ipv4_dhcps_write", dhcps_url)
            current = router.request(dhcps_url, "operation=read")
            if not isinstance(current, dict):
                current = {}

            enable_val = settings.get("enabled")
            if enable_val is None:
                enable_str = current.get("enable", "on")
            else:
                enable_str = "on" if enable_val else "off"

            payload = {
                "operation": "write",
                "enable": enable_str,
                "ipaddr_start": settings.get("ip_start") or current.get("ipaddr_start", ""),
                "ipaddr_end": settings.get("ip_end") or current.get("ipaddr_end", ""),
                "leasetime": str(settings.get("lease_time") or current.get("leasetime", "120")),
                "gateway": settings.get("gateway") or current.get("gateway", ""),
                "pri_dns": settings.get("pri_dns") if "pri_dns" in settings else current.get("pri_dns", ""),
                "snd_dns": settings.get("snd_dns") if "snd_dns" in settings else current.get("snd_dns", ""),
                "domain": settings.get("domain") if "domain" in settings else current.get("domain", ""),
            }
            # Remove empty optional keys if router did not have them
            clean_payload = {k: v for k, v in payload.items() if v != "" or k in ("pri_dns", "snd_dns")}
            router.request(dhcps_write_url, urlencode(clean_payload))
        finally:
            try:
                router.logout()
            except Exception:
                pass

    async def async_add_dhcp_reservation(
        self, mac: str, ip: str, hostname: str = "", enable: bool = True
    ) -> None:
        """Add or update a DHCP address reservation and refresh coordinator."""
        async with self._router_lock:
            try:
                await self.hass.async_add_executor_job(
                    self._add_or_update_reservation_sync, mac, ip, hostname, enable
                )
            except Exception as err:
                raise HomeAssistantError(f"Failed to save DHCP reservation for {mac} ({ip}): {err}") from err
        await self.async_request_refresh()

    async def async_delete_dhcp_reservation(self, mac: str) -> None:
        """Delete a DHCP address reservation and refresh coordinator."""
        async with self._router_lock:
            try:
                await self.hass.async_add_executor_job(
                    self._delete_reservation_sync, mac
                )
            except Exception as err:
                raise HomeAssistantError(f"Failed to delete DHCP reservation for {mac}: {err}") from err
        await self.async_request_refresh()

    async def async_update_dhcp_server(self, settings: dict[str, Any]) -> None:
        """Update DHCP server settings and refresh coordinator."""
        async with self._router_lock:
            try:
                await self.hass.async_add_executor_job(
                    self._update_dhcp_server_sync, settings
                )
            except Exception as err:
                raise HomeAssistantError(f"Failed to update DHCP server settings: {err}") from err
        await self.async_request_refresh()

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch data from the TP-Link Archer BE230 router."""
        async with self._router_lock:
            try:
                raw = await self.hass.async_add_executor_job(self._poll_router_sync)
            except Exception as err:
                err_msg = str(err)
                if "Login failed" in err_msg or "Incorrect" in err_msg or "auth" in err_msg.lower():
                    raise ConfigEntryAuthFailed(f"Authentication failed on {self.host}: {err}") from err
                raise UpdateFailed(f"Error communicating with {self.host}: {err}") from err

        fw = raw["firmware"]
        status = raw["status"]
        reservations_raw = raw.get("reservations", [])
        leases_raw = raw.get("leases", [])
        dhcps_settings = raw.get("dhcps_settings", {})
        now_iso = datetime.now(timezone.utc).isoformat()

        if fw:
            self.firmware_info = {
                "model": fw.model or "Archer BE230",
                "hardware_version": fw.hardware_version or "1.0",
                "firmware_version": fw.firmware_version or "Unknown",
            }

        reservations_by_mac: dict[str, dict[str, Any]] = {}
        reservations_list: list[dict[str, Any]] = []
        for r in reservations_raw:
            rmac = normalize_mac(r.macaddr)
            r_dict = {
                "mac": rmac,
                "ip": str(r.ipaddr),
                "hostname": (r.hostname or "").strip() or f"Device {rmac[-8:]}",
                "enabled": bool(getattr(r, "enabled", True)),
            }
            reservations_by_mac[rmac] = r_dict
            reservations_list.append(r_dict)

        leases_by_mac: dict[str, dict[str, Any]] = {}
        leases_list: list[dict[str, Any]] = []
        for l in leases_raw:
            lmac = normalize_mac(l.macaddr)
            l_dict = {
                "mac": lmac,
                "ip": str(l.ipaddr),
                "hostname": (l.hostname or "").strip() or f"Device {lmac[-8:]}",
                "lease_time": str(getattr(l, "lease_time", "")),
            }
            leases_by_mac[lmac] = l_dict
            leases_list.append(l_dict)

        for dev in self.known_devices.values():
            dev["active"] = False

        new_macs: list[str] = []
        active_devices_list: list[dict[str, Any]] = []

        for d in getattr(status, "devices", []) or []:
            mac = normalize_mac(d.macaddr)
            net_code = d.type.value if hasattr(d.type, "value") else str(d.type)
            net_label = NETWORK_LABELS.get(net_code, net_code)
            band = NETWORK_BANDS.get(net_code, "Unknown")
            is_active = bool(getattr(d, "active", True))

            res_info = reservations_by_mac.get(mac)
            lease_info = leases_by_mac.get(mac)

            hostname = (d.hostname or "").strip()
            if (not hostname or hostname == "--") and res_info:
                hostname = res_info["hostname"]
            if (not hostname or hostname == "--") and lease_info:
                hostname = lease_info["hostname"]
            if not hostname or hostname == "--":
                hostname = f"Device {mac[-8:]}"

            dev_dict = {
                "mac": mac,
                "ip": str(d.ipaddr) if d.ipaddr else (res_info["ip"] if res_info else "0.0.0.0"),
                "hostname": hostname,
                "network": net_label,
                "network_type": net_code,
                "band": band,
                "is_wired": net_code == "wired",
                "is_guest": net_code.startswith("guest_"),
                "is_iot": net_code.startswith("iot_"),
                "active": is_active,
                "is_reserved": res_info is not None,
                "reserved_ip": res_info["ip"] if res_info else None,
                "reservation_name": res_info["hostname"] if res_info else None,
                "reservation_enabled": res_info["enabled"] if res_info else None,
                "lease_time": lease_info["lease_time"] if lease_info else None,
                "signal": getattr(d, "signal", None),
                "down_speed": getattr(d, "down_speed", None),
                "up_speed": getattr(d, "up_speed", None),
                "tx_rate": getattr(d, "tx_rate", None),
                "rx_rate": getattr(d, "rx_rate", None),
                "packets_sent": getattr(d, "packets_sent", None),
                "packets_received": getattr(d, "packets_received", None),
                "online_time": getattr(d, "online_time", None),
                "traffic_usage": getattr(d, "traffic_usage", None),
                "ssid": getattr(d, "ssid", None),
                "last_seen": now_iso if is_active else self.known_devices.get(mac, {}).get("last_seen", now_iso),
            }

            self.known_devices[mac] = dev_dict
            if is_active:
                active_devices_list.append(dev_dict)

            if mac not in self.registered_macs:
                new_macs.append(mac)

        # Also ensure any offline reserved device appears in known_devices
        for rmac, rinfo in reservations_by_mac.items():
            if rmac not in self.known_devices:
                self.known_devices[rmac] = {
                    "mac": rmac,
                    "ip": rinfo["ip"],
                    "hostname": rinfo["hostname"],
                    "network": "Offline (Reserved)",
                    "network_type": "unknown",
                    "band": "Offline",
                    "is_wired": False,
                    "is_guest": False,
                    "is_iot": False,
                    "active": False,
                    "is_reserved": True,
                    "reserved_ip": rinfo["ip"],
                    "reservation_name": rinfo["hostname"],
                    "reservation_enabled": rinfo["enabled"],
                    "lease_time": "Permanent",
                    "signal": None,
                    "down_speed": None,
                    "up_speed": None,
                    "tx_rate": None,
                    "rx_rate": None,
                    "packets_sent": None,
                    "packets_received": None,
                    "online_time": None,
                    "traffic_usage": None,
                    "ssid": None,
                    "last_seen": None,
                }
                if rmac not in self.registered_macs:
                    new_macs.append(rmac)
            else:
                self.known_devices[rmac]["is_reserved"] = True
                self.known_devices[rmac]["reserved_ip"] = rinfo["ip"]
                self.known_devices[rmac]["reservation_name"] = rinfo["hostname"]
                self.known_devices[rmac]["reservation_enabled"] = rinfo["enabled"]

        if new_macs:
            async_dispatcher_send(
                self.hass,
                f"{SIGNAL_NEW_DEVICE}_{self.entry.entry_id}",
                new_macs,
            )

        cpu_raw = getattr(status, "cpu_usage", None)
        mem_raw = getattr(status, "mem_usage", None)
        cpu_pct = round(cpu_raw * 100, 1) if isinstance(cpu_raw, (int, float)) and cpu_raw <= 1 else cpu_raw
        mem_pct = round(mem_raw * 100, 1) if isinstance(mem_raw, (int, float)) and mem_raw <= 1 else mem_raw

        return {
            "firmware": self.firmware_info,
            "wan_ip": str(status.wan_ipv4_addr) if getattr(status, "wan_ipv4_addr", None) else None,
            "lan_ip": str(status.lan_ipv4_addr) if getattr(status, "lan_ipv4_addr", None) else None,
            "wan_gateway": str(status.wan_ipv4_gateway) if getattr(status, "wan_ipv4_gateway", None) else None,
            "lan_mac": str(status.lan_macaddr) if getattr(status, "lan_macaddr", None) else None,
            "wan_mac": str(status.wan_macaddr) if getattr(status, "wan_macaddr", None) else None,
            "cpu_usage": cpu_pct,
            "mem_usage": mem_pct,
            "clients_total": getattr(status, "clients_total", len(active_devices_list)),
            "wifi_clients_total": getattr(status, "wifi_clients_total", 0),
            "wired_total": getattr(status, "wired_total", 0),
            "guest_clients_total": getattr(status, "guest_clients_total", 0),
            "iot_clients_total": getattr(status, "iot_clients_total", 0) or 0,
            "wifi_2g_enable": getattr(status, "wifi_2g_enable", None),
            "wifi_5g_enable": getattr(status, "wifi_5g_enable", None),
            "wifi_6g_enable": getattr(status, "wifi_6g_enable", None),
            "guest_2g_enable": getattr(status, "guest_2g_enable", None),
            "guest_5g_enable": getattr(status, "guest_5g_enable", None),
            "iot_2g_enable": getattr(status, "iot_2g_enable", None),
            "iot_5g_enable": getattr(status, "iot_5g_enable", None),
            "dhcp_server": dhcps_settings,
            "dhcp_reservations": reservations_list,
            "dhcp_leases": leases_list,
            "devices": list(self.known_devices.values()),
            "active_devices": active_devices_list,
            "last_update": now_iso,
        }
