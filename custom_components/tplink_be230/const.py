"""Constants for the TP-Link Archer BE230 integration."""
from datetime import timedelta

DOMAIN = "tplink_be230"

CONF_HOST = "host"
CONF_PASSWORD = "password"
CONF_USERNAME = "username"
CONF_VERIFY_SSL = "verify_ssl"
CONF_SCAN_INTERVAL = "scan_interval"

DEFAULT_HOST = "http://192.168.1.1"
DEFAULT_USERNAME = "admin"
DEFAULT_VERIFY_SSL = False
DEFAULT_SCAN_INTERVAL = 30

SIGNAL_NEW_DEVICE = f"{DOMAIN}_new_device"

NETWORK_LABELS = {
    "host_2g": "Wi-Fi 2.4GHz",
    "host_5g": "Wi-Fi 5GHz",
    "host_6g": "Wi-Fi 6GHz",
    "host_mlo": "Wi-Fi 7 MLO",
    "guest_2g": "Guest 2.4GHz",
    "guest_5g": "Guest 5GHz",
    "guest_6g": "Guest 6GHz",
    "iot_2g": "IoT 2.4GHz",
    "iot_5g": "IoT 5GHz",
    "iot_6g": "IoT 6GHz",
    "wired": "Ethernet (LAN)",
    "unknown": "Desconocida",
}

NETWORK_BANDS = {
    "host_2g": "2.4GHz",
    "host_5g": "5GHz",
    "host_6g": "6GHz",
    "host_mlo": "MLO",
    "guest_2g": "2.4GHz",
    "guest_5g": "5GHz",
    "guest_6g": "6GHz",
    "iot_2g": "2.4GHz",
    "iot_5g": "5GHz",
    "iot_6g": "6GHz",
    "wired": "LAN",
    "unknown": "Unknown",
}
