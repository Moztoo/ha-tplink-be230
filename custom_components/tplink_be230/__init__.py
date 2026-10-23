"""The TP-Link Archer BE230 integration."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from .const import DOMAIN
from .coordinator import TplinkBE230Coordinator

PLATFORMS: list[Platform] = [
    Platform.DEVICE_TRACKER,
    Platform.SENSOR,
    Platform.BUTTON,
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up TP-Link Archer BE230 from a config entry."""
    coordinator = TplinkBE230Coordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    # Register router device in Device Registry
    device_registry = dr.async_get(hass)
    fw = coordinator.firmware_info
    lan_mac = coordinator.data.get("lan_mac") or entry.unique_id or entry.entry_id
    connections = {(dr.CONNECTION_NETWORK_MAC, dr.format_mac(lan_mac))} if ":" in str(lan_mac) or "-" in str(lan_mac) else set()

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

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload config entry when options (password, host, scan interval) change."""
    await hass.config_entries.async_reload(entry.entry_id)
