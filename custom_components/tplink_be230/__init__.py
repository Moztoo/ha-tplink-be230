"""The TP-Link Archer BE230 integration."""
from __future__ import annotations

from typing import Any
import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv, device_registry as dr

from .const import DOMAIN
from .coordinator import TplinkBE230Coordinator

PLATFORMS: list[Platform] = [
    Platform.DEVICE_TRACKER,
    Platform.SENSOR,
    Platform.BUTTON,
]

SERVICE_ADD_RESERVATION = "add_dhcp_reservation"
SERVICE_DELETE_RESERVATION = "delete_dhcp_reservation"
SERVICE_SET_DHCP_SERVER = "set_dhcp_server"

SCHEMA_ADD_RESERVATION = vol.Schema(
    {
        vol.Required("mac"): cv.string,
        vol.Required("ip"): cv.string,
        vol.Optional("hostname", default=""): cv.string,
        vol.Optional("enable", default=True): cv.boolean,
        vol.Optional("entry_id"): cv.string,
    }
)

SCHEMA_DELETE_RESERVATION = vol.Schema(
    {
        vol.Required("mac"): cv.string,
        vol.Optional("entry_id"): cv.string,
    }
)

SCHEMA_SET_DHCP_SERVER = vol.Schema(
    {
        vol.Optional("enabled"): cv.boolean,
        vol.Optional("ip_start"): cv.string,
        vol.Optional("ip_end"): cv.string,
        vol.Optional("lease_time"): vol.Any(cv.string, vol.Coerce(int)),
        vol.Optional("gateway"): cv.string,
        vol.Optional("pri_dns"): cv.string,
        vol.Optional("snd_dns"): cv.string,
        vol.Optional("domain"): cv.string,
        vol.Optional("entry_id"): cv.string,
    }
)


def _get_coordinator(hass: HomeAssistant, entry_id: str | None = None) -> TplinkBE230Coordinator:
    """Resolve the active TplinkBE230Coordinator instance."""
    domain_data: dict[str, TplinkBE230Coordinator] = hass.data.get(DOMAIN, {})
    if not domain_data:
        raise HomeAssistantError("TP-Link Archer BE230 integration is not loaded.")
    if entry_id and entry_id in domain_data:
        return domain_data[entry_id]
    return next(iter(domain_data.values()))


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up TP-Link Archer BE230 from a config entry."""
    coordinator = TplinkBE230Coordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    # Register router device in Device Registry
    device_registry = dr.async_get(hass)
    fw = coordinator.firmware_info
    lan_mac = coordinator.data.get("lan_mac") or entry.unique_id or entry.entry_id
    connections = (
        {(dr.CONNECTION_NETWORK_MAC, dr.format_mac(lan_mac))}
        if ":" in str(lan_mac) or "-" in str(lan_mac)
        else set()
    )

    device_registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        connections=connections,
        identifiers={(DOMAIN, entry.entry_id)},
        manufacturer="TP-Link",
        model=fw.get("model", "Archer BE230"),
        name=f"TP-Link {fw.get('model', 'Archer BE230')}",
        sw_version=fw.get("firmware_version"),
        hw_version=fw.get("hardware_version"),
        configuration_url=coordinator.host,
    )

    # Register DHCP Manager services once
    if not hass.services.has_service(DOMAIN, SERVICE_ADD_RESERVATION):

        async def _handle_add_reservation(call: ServiceCall) -> None:
            coord = _get_coordinator(hass, call.data.get("entry_id"))
            await coord.async_add_dhcp_reservation(
                mac=call.data["mac"],
                ip=call.data["ip"],
                hostname=call.data.get("hostname", ""),
                enable=call.data.get("enable", True),
            )

        async def _handle_delete_reservation(call: ServiceCall) -> None:
            coord = _get_coordinator(hass, call.data.get("entry_id"))
            await coord.async_delete_dhcp_reservation(mac=call.data["mac"])

        async def _handle_set_dhcp_server(call: ServiceCall) -> None:
            coord = _get_coordinator(hass, call.data.get("entry_id"))
            settings: dict[str, Any] = {
                k: v for k, v in call.data.items() if k != "entry_id"
            }
            await coord.async_update_dhcp_server(settings)

        hass.services.async_register(
            DOMAIN,
            SERVICE_ADD_RESERVATION,
            _handle_add_reservation,
            schema=SCHEMA_ADD_RESERVATION,
        )
        hass.services.async_register(
            DOMAIN,
            SERVICE_DELETE_RESERVATION,
            _handle_delete_reservation,
            schema=SCHEMA_DELETE_RESERVATION,
        )
        hass.services.async_register(
            DOMAIN,
            SERVICE_SET_DHCP_SERVER,
            _handle_set_dhcp_server,
            schema=SCHEMA_SET_DHCP_SERVER,
        )

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        hass.data[DOMAIN].pop(entry.entry_id, None)
        if not hass.data[DOMAIN]:
            hass.services.async_remove(DOMAIN, SERVICE_ADD_RESERVATION)
            hass.services.async_remove(DOMAIN, SERVICE_DELETE_RESERVATION)
            hass.services.async_remove(DOMAIN, SERVICE_SET_DHCP_SERVER)
    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload config entry when options (password, host, scan interval) change."""
    await hass.config_entries.async_reload(entry.entry_id)
