"""Button platform for TP-Link Archer BE230 (Reboot)."""
from __future__ import annotations

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import TplinkBE230Coordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up reboot button for TP-Link Archer BE230."""
    coordinator: TplinkBE230Coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([TplinkBE230RebootButton(coordinator, entry)])


class TplinkBE230RebootButton(CoordinatorEntity[TplinkBE230Coordinator], ButtonEntity):
    """Button entity to reboot the TP-Link Archer BE230 router."""

    _attr_has_entity_name = True
    _attr_name = "Reiniciar Router"
    _attr_device_class = ButtonDeviceClass.RESTART
    _attr_icon = "mdi:restart"

    def __init__(
        self,
        coordinator: TplinkBE230Coordinator,
        entry: ConfigEntry,
    ) -> None:
        """Initialize the reboot button."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_reboot"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=f"TP-Link {coordinator.firmware_info.get('model', 'Archer BE230')}",
            manufacturer="TP-Link",
            model=coordinator.firmware_info.get("model", "Archer BE230"),
            sw_version=coordinator.firmware_info.get("firmware_version"),
            hw_version=coordinator.firmware_info.get("hardware_version"),
            configuration_url=coordinator.host,
        )

    async def async_press(self) -> None:
        """Trigger router reboot."""
        await self.hass.async_add_executor_job(self.coordinator.reboot_router_sync)
