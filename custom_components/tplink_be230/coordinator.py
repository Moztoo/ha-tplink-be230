"""DataUpdateCoordinator for the TP-Link Archer BE230 integration."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
from typing import Any

from tplinkrouterc6u import TplinkRouterProvider

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
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
    cleaned = mac.strip().upper().replace("-", ":")
    return cleaned


class TplinkBE230Coordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator to poll TP-Link Archer BE230 router status and connected clients."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the coordinator."""
        self.entry = entry
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

    def _poll_router_sync(self) -> dict[str, Any]:
        """Fetch firmware and status from the router synchronously in executor."""
        router = TplinkRouterProvider.get_client(
            self.host,
            self.password,
            self.username,
            _LOGGER,
            self.verify_ssl,
        )
        try:
            router.authorize()
            fw = router.get_firmware()
            status = router.get_status()
            return {
                "firmware": fw,
                "status": status,
            }
        finally:
            try:
                router.logout()
            except Exception:
                pass

    def reboot_router_sync(self) -> None:
        """Reboot the router synchronously in executor."""
        router = TplinkRouterProvider.get_client(
            self.host,
            self.password,
            self.username,
            _LOGGER,
            self.verify_ssl,
        )
        try:
            router.authorize()
            router.reboot()
        finally:
            try:
                router.logout()
            except Exception:
                pass

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch data from the TP-Link Archer BE230 router."""
        try:
            raw = await self.hass.async_add_executor_job(self._poll_router_sync)
        except Exception as err:
            err_msg = str(err)
            if "Login failed" in err_msg or "Incorrect" in err_msg or "auth" in err_msg.lower():
                raise ConfigEntryAuthFailed(f"Error de autenticación en {self.host}: {err}") from err
            raise UpdateFailed(f"Error comunicando con {self.host}: {err}") from err

        fw = raw["firmware"]
        status = raw["status"]
        now_iso = datetime.now(timezone.utc).isoformat()

        if fw:
            self.firmware_info = {
                "model": fw.model or "Archer BE230",
                "hardware_version": fw.hardware_version or "1.0",
                "firmware_version": fw.firmware_version or "Unknown",
            }

        # Mark all previously known devices as inactive until seen in current poll
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

            hostname = (d.hostname or "").strip()
            if not hostname or hostname == "--":
                hostname = f"Device {mac[-8:]}"

            dev_dict = {
                "mac": mac,
                "ip": str(d.ipaddr) if d.ipaddr else "0.0.0.0",
                "hostname": hostname,
                "network": net_label,
                "network_type": net_code,
                "band": band,
                "is_wired": net_code == "wired",
                "is_guest": net_code.startswith("guest_"),
                "is_iot": net_code.startswith("iot_"),
                "active": is_active,
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
            "devices": list(self.known_devices.values()),
            "active_devices": active_devices_list,
            "last_update": now_iso,
        }
