"""Sensor platform for TP-Link Archer BE230 router metrics and device summary."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from homeassistant.components.sensor import (
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import TplinkBE230Coordinator


@dataclass(frozen=True, kw_only=True)
class BE230SensorEntityDescription(SensorEntityDescription):
    """Describe a TP-Link Archer BE230 sensor entity."""

    value_fn: Callable[[dict[str, Any]], Any]
    attr_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None


SENSOR_DESCRIPTIONS: tuple[BE230SensorEntityDescription, ...] = (
    BE230SensorEntityDescription(
        key="connected_devices",
        name="Dispositivos Conectados",
        icon="mdi:devices",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement="clients",
        value_fn=lambda data: data.get("clients_total", 0),
        attr_fn=lambda data: {
            "model": data.get("firmware", {}).get("model"),
            "firmware_version": data.get("firmware", {}).get("firmware_version"),
            "hardware_version": data.get("firmware", {}).get("hardware_version"),
            "wan_ip": data.get("wan_ip"),
            "lan_ip": data.get("lan_ip"),
            "wan_gateway": data.get("wan_gateway"),
            "lan_mac": data.get("lan_mac"),
            "cpu_usage": data.get("cpu_usage"),
            "mem_usage": data.get("mem_usage"),
            "clients_total": data.get("clients_total", 0),
            "wifi_clients_total": data.get("wifi_clients_total", 0),
            "wired_total": data.get("wired_total", 0),
            "guest_clients_total": data.get("guest_clients_total", 0),
            "iot_clients_total": data.get("iot_clients_total", 0),
            "wifi_2g_enable": data.get("wifi_2g_enable"),
            "wifi_5g_enable": data.get("wifi_5g_enable"),
            "wifi_6g_enable": data.get("wifi_6g_enable"),
            "guest_2g_enable": data.get("guest_2g_enable"),
            "guest_5g_enable": data.get("guest_5g_enable"),
            "iot_2g_enable": data.get("iot_2g_enable"),
            "iot_5g_enable": data.get("iot_5g_enable"),
            "last_update": data.get("last_update"),
            "devices": data.get("devices", []),
        },
    ),
    BE230SensorEntityDescription(
        key="wan_ip",
        name="IP WAN",
        icon="mdi:ip-network",
        value_fn=lambda data: data.get("wan_ip") or "Sin conexión",
    ),
    BE230SensorEntityDescription(
        key="lan_ip",
        name="IP LAN",
        icon="mdi:lan",
        value_fn=lambda data: data.get("lan_ip"),
    ),
    BE230SensorEntityDescription(
        key="cpu_usage",
        name="Uso de CPU",
        icon="mdi:cpu-64-bit",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda data: data.get("cpu_usage"),
    ),
    BE230SensorEntityDescription(
        key="memory_usage",
        name="Uso de Memoria",
        icon="mdi:memory",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda data: data.get("mem_usage"),
    ),
    BE230SensorEntityDescription(
        key="wifi_clients",
        name="Clientes Wi-Fi",
        icon="mdi:wifi",
        native_unit_of_measurement="clients",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda data: data.get("wifi_clients_total", 0),
    ),
    BE230SensorEntityDescription(
        key="wired_clients",
        name="Clientes por Cable",
        icon="mdi:ethernet",
        native_unit_of_measurement="clients",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda data: data.get("wired_total", 0),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up TP-Link Archer BE230 sensors."""
    coordinator: TplinkBE230Coordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        TplinkBE230Sensor(coordinator, entry, description)
        for description in SENSOR_DESCRIPTIONS
    )


class TplinkBE230Sensor(CoordinatorEntity[TplinkBE230Coordinator], SensorEntity):
    """Representation of a TP-Link Archer BE230 sensor."""

    entity_description: BE230SensorEntityDescription
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: TplinkBE230Coordinator,
        entry: ConfigEntry,
        description: BE230SensorEntityDescription,
    ) -> None:
        """Initialize the sensor."""
        super().__init__(coordinator)
        self.entity_description = description
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=f"TP-Link {coordinator.firmware_info.get('model', 'Archer BE230')}",
            manufacturer="TP-Link",
            model=coordinator.firmware_info.get("model", "Archer BE230"),
            sw_version=coordinator.firmware_info.get("firmware_version"),
            hw_version=coordinator.firmware_info.get("hardware_version"),
            configuration_url=coordinator.host,
        )

    @property
    def native_value(self) -> Any:
        """Return the state of the sensor."""
        return self.entity_description.value_fn(self.coordinator.data or {})

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return extra attributes if defined."""
        if self.entity_description.attr_fn:
            return self.entity_description.attr_fn(self.coordinator.data or {})
        return None
