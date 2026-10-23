#!/usr/bin/env python3
"""
CLI administration & DHCP Manager tool for TP-Link Archer BE230 using tplinkrouterc6u.
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
        password = getpass.getpass(f"Password for {host}: ")
    return host, password


def cmd_status(router):
    fw = router.get_firmware()
    status = router.get_status()

    print("=== Device Information ===")
    print(f"Model:             {fw.model}")
    print(f"Hardware Version:  {fw.hardware_version}")
    print(f"Firmware Version:  {fw.firmware_version}")

    print("\n=== General Status ===")
    print(f"WAN IP:            {status.wan_ipv4_addr}")
    print(f"WAN Gateway:       {status.wan_ipv4_gateway}")
    print(f"LAN IP:            {status.lan_ipv4_addr}")
    print(f"LAN MAC:           {status.lan_macaddr}")
    print(f"CPU Usage:         {status.cpu_usage}")
    print(f"Memory Usage:      {status.mem_usage}")
    print(f"Wi-Fi 2.4GHz:      {'Enabled' if status.wifi_2g_enable else 'Disabled'}")
    print(f"Wi-Fi 5GHz:        {'Enabled' if status.wifi_5g_enable else 'Disabled'}")
    print(f"Total Clients:     {status.clients_total} (Wi-Fi: {status.wifi_clients_total}, Wired: {status.wired_total})")


def cmd_devices(router):
    status = router.get_status()
    print(f"=== Connected Devices ({len(status.devices)}) ===")
    for dev in sorted(status.devices, key=lambda d: str(d.ipaddr)):
        print(
            f"- {dev.hostname:28} | IP: {str(dev.ipaddr):15} | "
            f"MAC: {str(dev.macaddr):17} | Net: {dev.type.name:10} | "
            f"TX/RX: {dev.packets_sent}/{dev.packets_received}"
        )


def cmd_ipv4(router):
    ipv4 = router.get_ipv4_status()
    print("=== IPv4 Status ===")
    print(f"WAN MAC:           {ipv4.wan_macaddr}")
    print(f"WAN IP:            {ipv4.wan_ipv4_ipaddr}")
    print(f"WAN Gateway:       {ipv4.wan_ipv4_gateway}")
    print(f"WAN Netmask:       {ipv4.wan_ipv4_netmask}")
    print(f"Primary DNS:       {ipv4.wan_ipv4_pridns}")
    print(f"Secondary DNS:     {ipv4.wan_ipv4_snddns}")
    print(f"LAN IP:            {ipv4.lan_ipv4_ipaddr}")
    print(f"DHCP Enabled:      {ipv4.lan_ipv4_dhcp_enable}")


def cmd_dhcp(router, args):
    action = getattr(args, "dhcp_action", None) or "status"
    if action == "reserve":
        mac = args.mac.strip().upper().replace("-", ":")
        existing = router.get_ipv4_reservations()
        for r in existing:
            if r.macaddr.upper().replace("-", ":") == mac:
                router.delete_ipv4_reservation(mac)
                break
        router.add_ipv4_reservation(mac, args.ip.strip(), (args.name or "").strip(), True)
        print(f"Saved static DHCP reservation: {args.ip} -> {mac} ({args.name or ''})")
        return

    if action == "delete":
        mac = args.mac.strip().upper().replace("-", ":")
        router.delete_ipv4_reservation(mac)
        print(f"Removed static DHCP reservation for {mac}")
        return

    dhcps_url = getattr(router, "_url_ipv4_dhcps", "admin/dhcps?form=setting")
    dhcps = router.request(dhcps_url, "operation=read") or {}
    reservations = router.get_ipv4_reservations()
    leases = router.get_ipv4_dhcp_leases()

    print("=== DHCP Server Settings ===")
    print(f"Enabled:           {dhcps.get('enable', 'on')}")
    print(f"IP Pool:           {dhcps.get('ipaddr_start', '')} - {dhcps.get('ipaddr_end', '')}")
    print(f"Lease Time:        {dhcps.get('leasetime', '')} min")
    print(f"Default Gateway:   {dhcps.get('gateway', '')}")
    print(f"DNS Servers:       {dhcps.get('pri_dns', '')} / {dhcps.get('snd_dns', '')}")

    print(f"\n=== Static DHCP Reservations ({len(reservations)}) ===")
    for r in reservations:
        print(f" 📌 {str(r.ipaddr):15} | MAC: {str(r.macaddr):17} | Name: {r.hostname:25} | Enabled: {r.enabled}")

    print(f"\n=== Active DHCP Leases ({len(leases)}) ===")
    for l in leases:
        print(f" ⏱️ {str(l.ipaddr):15} | MAC: {str(l.macaddr):17} | Name: {l.hostname:25} | Lease: {l.lease_time}")


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
    print(f"Wi-Fi {args.band} -> {'ON' if enable else 'OFF'}")


def cmd_reboot(router):
    router.reboot()
    print("Reboot command sent to router.")


def main():
    parser = argparse.ArgumentParser(description="CLI & DHCP Manager for TP-Link Archer BE230")
    parser.add_argument("--host", help="Router URL or IP (default: http://192.168.1.1)")
    parser.add_argument("-p", "--password", help="Router local admin password")

    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("status", help="Show firmware info and general status")
    subparsers.add_parser("devices", help="List connected devices")
    subparsers.add_parser("ipv4", help="Show detailed WAN/LAN IPv4 configuration")
    subparsers.add_parser("all", help="Show general status and connected devices (default)")
    subparsers.add_parser("reboot", help="Reboot the router")

    dhcp_parser = subparsers.add_parser("dhcp", help="DHCP Server & Static IP Reservation Manager")
    dhcp_sub = dhcp_parser.add_subparsers(dest="dhcp_action")
    dhcp_sub.add_parser("status", help="Show DHCP pool settings, static reservations, and leases")
    res_p = dhcp_sub.add_parser("reserve", help="Add or update a static IP reservation")
    res_p.add_argument("mac", help="Device MAC address")
    res_p.add_argument("ip", help="Static IPv4 address to reserve")
    res_p.add_argument("name", nargs="?", default="", help="Device description/hostname")
    del_p = dhcp_sub.add_parser("delete", help="Delete a static IP reservation by MAC")
    del_p.add_argument("mac", help="Device MAC address")

    wifi_parser = subparsers.add_parser("wifi", help="Enable or disable a Wi-Fi band")
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
        elif command == "dhcp":
            cmd_dhcp(router, args)
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
