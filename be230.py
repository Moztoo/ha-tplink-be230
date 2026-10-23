#!/usr/bin/env python3
"""
CLI y script de prueba para el router TP-Link Archer BE230 usando tplinkrouterc6u.
"""
import argparse
import getpass
import os
import sys
from pathlib import Path
from tplinkrouterc6u import TplinkRouterProvider, Connection


def load_dotenv():
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def get_credentials(args):
    load_dotenv()
    host = args.host or os.environ.get("TPLINK_HOST", "http://192.168.1.1")
    password = args.password or os.environ.get("TPLINK_PASSWORD")
    if not password:
        password = getpass.getpass(f"Contraseña para {host}: ")
    return host, password


def cmd_status(router):
    fw = router.get_firmware()
    status = router.get_status()

    print("=== Información del Dispositivo ===")
    print(f"Modelo:            {fw.model}")
    print(f"Versión Hardware:  {fw.hardware_version}")
    print(f"Versión Firmware:  {fw.firmware_version}")

    print("\n=== Estado General ===")
    print(f"IP WAN:            {status.wan_ipv4_addr}")
    print(f"Gateway WAN:       {status.wan_ipv4_gateway}")
    print(f"IP LAN:            {status.lan_ipv4_addr}")
    print(f"MAC LAN:           {status.lan_macaddr}")
    print(f"Uso de CPU:        {status.cpu_usage}")
    print(f"Uso de Memoria:    {status.mem_usage}")
    print(f"Wi-Fi 2.4GHz:      {'Activo' if status.wifi_2g_enable else 'Inactivo'}")
    print(f"Wi-Fi 5GHz:        {'Activo' if status.wifi_5g_enable else 'Inactivo'}")
    print(f"Total Clientes:    {status.clients_total} (Wi-Fi: {status.wifi_clients_total}, Cable: {status.wired_total})")


def cmd_devices(router):
    status = router.get_status()
    print(f"=== Dispositivos Conectados ({len(status.devices)}) ===")
    for dev in sorted(status.devices, key=lambda d: str(d.ipaddr)):
        print(
            f"- {dev.hostname:28} | IP: {str(dev.ipaddr):15} | "
            f"MAC: {str(dev.macaddr):17} | Tipo: {dev.type.name:12} | "
            f"TX/RX: {dev.packets_sent}/{dev.packets_received}"
        )


def cmd_ipv4(router):
    ipv4 = router.get_ipv4_status()
    print("=== Estado IPv4 ===")
    print(f"WAN MAC:           {ipv4.wan_macaddr}")
    print(f"WAN IP:            {ipv4.wan_ipv4_ipaddr}")
    print(f"WAN Gateway:       {ipv4.wan_ipv4_gateway}")
    print(f"WAN máscara:       {ipv4.wan_ipv4_netmask}")
    print(f"DNS Primario:      {ipv4.wan_ipv4_pridns}")
    print(f"DNS Secundario:    {ipv4.wan_ipv4_snddns}")
    print(f"LAN IP:            {ipv4.lan_ipv4_ipaddr}")
    print(f"DHCP Activo:       {ipv4.lan_ipv4_dhcp_enable}")


def cmd_wifi(router, args):
    band_map = {
        "2g": Connection.HOST_2G,
        "5g": Connection.HOST_5G,
        "guest2g": Connection.GUEST_2G,
        "guest5g": Connection.GUEST_5G,
        "iot2g": Connection.IOT_2G,
        "iot5g": Connection.IOT_5G,
    }
    conn = band_map[args.band]
    enable = args.state == "on"
    router.set_wifi(conn, enable)
    print(f"Wi-Fi {args.band} -> {'ENCENDIDO' if enable else 'APAGADO'}")


def cmd_reboot(router):
    router.reboot()
    print("Comando de reinicio enviado al router.")


def main():
    parser = argparse.ArgumentParser(description="CLI de administración para TP-Link Archer BE230")
    parser.add_argument("--host", help="URL o IP del router (default: http://192.168.1.1)")
    parser.add_argument("-p", "--password", help="Contraseña local del router")

    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("status", help="Muestra información de firmware y estado general")
    subparsers.add_parser("devices", help="Lista los dispositivos conectados")
    subparsers.add_parser("ipv4", help="Muestra configuración detallada IPv4 WAN/LAN")
    subparsers.add_parser("all", help="Muestra estado general y dispositivos conectados (por defecto)")
    subparsers.add_parser("reboot", help="Reinicia el router")

    wifi_parser = subparsers.add_parser("wifi", help="Enciende o apaga una banda Wi-Fi")
    wifi_parser.add_argument("band", choices=["2g", "5g", "guest2g", "guest5g", "iot2g", "iot5g"])
    wifi_parser.add_argument("state", choices=["on", "off"])

    args = parser.parse_args()
    command = args.command or "all"

    host, password = get_credentials(args)
    if not host.startswith("http://") and not host.startswith("https://"):
        host = f"http://{host}"

    router = TplinkRouterProvider.get_client(host, password)
    try:
        router.authorize()
        if command == "status":
            cmd_status(router)
        elif command == "devices":
            cmd_devices(router)
        elif command == "ipv4":
            cmd_ipv4(router)
        elif command == "wifi":
            cmd_wifi(router, args)
        elif command == "reboot":
            cmd_reboot(router)
        else:
            cmd_status(router)
            print()
            cmd_devices(router)
    finally:
        try:
            router.logout()
        except Exception:
            pass


if __name__ == "__main__":
    main()
