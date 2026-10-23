"""Device tracker platform for TP-Link Archer BE230 connected clients."""
from __future__ import annotations

from typing import Any

from homeassistant.components.device_tracker import ScannerEntity, SourceType
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, SIGNAL_NEW_DEVICE
from .coordinator import TplinkBE230Coordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up device tracker entities for connected devices on TP-Link BE230."""
    coordinator: TplinkBE230Coordinator = hass.data[DOMAIN][entry.entry_id]
    ent_reg = er.async_get(hass)

    # Re-enable any entities that were previously auto-disabled by ScannerEntity default behavior
    for reg_entry in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
        if reg_entry.disabled_by == er.RegistryEntryDisabler.INTEGRATION:
            ent_reg.async_update_entity(reg_entry.entity_id, disabled_by=None)

    @callback
    def _async_add_new_devices(macs: list[str]) -> None:
        entities: list[TplinkBE230DeviceTracker] = []
        for mac in macs:
            if mac in coordinator.registered_macs:
                continue
            coordinator.registered_macs.add(mac)
            entities.append(TplinkBE230DeviceTracker(coordinator, entry, mac))
        if entities:
            async_add_entities(entities)

    # Register existing devices discovered during first refresh
    initial_macs = list(coordinator.known_devices.keys())
    _async_add_new_devices(initial_macs)

    # Listen for newly discovered devices in subsequent polls
    entry.async_on_unload(
        async_dispatcher_connect(
            hass,
            f"{SIGNAL_NEW_DEVICE}_{entry.entry_id}",
            _async_add_new_devices,
        )
    )


class TplinkBE230DeviceTracker(CoordinatorEntity[TplinkBE230Coordinator], ScannerEntity):
    """Represent a tracked network device connected to the TP-Link Archer BE230."""

    _attr_has_entity_name = False
    _attr_entity_registry_enabled_default = True

    def __init__(
        self,
        coordinator: TplinkBE230Coordinator,
        entry: ConfigEntry,
        mac: str,
    ) -> None:
        """Initialize the device tracker entity."""
        super().__init__(coordinator)
        self._entry = entry
        self._mac = mac
        mac_slug = mac.lower().replace(":", "_")
        self._attr_unique_id = f"{entry.entry_id}_tracker_{mac_slug}"

    @property
    def entity_registry_enabled_default(self) -> bool:
        """Enable all discovered router client entities by default."""
        return True

    @property
    def _device_data(self) -> dict[str, Any]:
        """Return latest dictionary for this device from coordinator."""
        return self.coordinator.known_devices.get(self._mac, {})

    @property
    def name(self) -> str:
        """Return the name of the device."""
        hostname = self._device_data.get("hostname")
        if hostname and hostname != "--":
            return hostname
        return f"BE230 Client {self._mac[-8:]}"

    @property
    def is_connected(self) -> bool:
        """Return true if the device is currently active on the router."""
        return bool(self._device_data.get("active", False))

    @property
    def source_type(self) -> SourceType:
        """Return the source type of the device."""
        return SourceType.ROUTER

    @property
    def ip_address(self) -> str | None:
        """Return the primary IP address of the device."""
        return self._device_data.get("ip")

    @property
    def mac_address(self) -> str:
        """Return the MAC address of the device."""
        return self._mac

    @property
    def hostname(self) -> str | None:
        """Return the hostname of the device."""
        return self._device_data.get("hostname")

    @property
    def icon(self) -> str:
        """Return an icon matching the connection network type."""
        net_type = self._device_data.get("network_type", "")
        if net_type == "wired":
            return "mdi:lan-connect" if self.is_connected else "mdi:lan-disconnect"
        if net_type.startswith("iot_"):
            return "mdi:access-point-network"
        if net_type.startswith("guest_"):
            return "mdi:wifi-lock-open"
        if net_type == "host_mlo":
            return "mdi:wifi-star"
        return "mdi:wifi" if self.is_connected else "mdi:wifi-off"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return network, IP, MAC, band, signal, and traffic attributes for the widget."""
        d = self._device_data
        return {
            "integration": DOMAIN,
            "router_entry_id": self._entry.entry_id,
            "hostname": d.get("hostname"),
            "ip": d.get("ip"),
            "mac": self._mac,
            "network": d.get("network", "Desconocida"),
            "network_type": d.get("network_type", "unknown"),
            "band": d.get("band", "Unknown"),
            "is_wired": d.get("is_wired", False),
            "is_guest": d.get("is_guest", False),
            "is_iot": d.get("is_iot", False),
            "active": d.get("active", False),
            "signal": d.get("signal"),
            "down_speed": d.get("down_speed"),
            "up_speed": d.get("up_speed"),
            "tx_rate": d.get("tx_rate"),
            "rx_rate": d.get("rx_rate"),
            "packets_sent": d.get("packets_sent"),
            "packets_received": d.get("packets_received"),
            "online_time": d.get("online_time"),
            "traffic_usage": d.get("traffic_usage"),
            "ssid": d.get("ssid"),
            "last_seen": d.get("last_seen"),
        }
