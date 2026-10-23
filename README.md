# ha-tplink-be230 — TP-Link Archer BE230 Home Assistant Integration, Lovelace Card & CLI

Repositorio completo para integrar y administrar el router **TP-Link Archer BE230** (`192.168.1.1`) en **Home Assistant** y desde la terminal mediante [`tplinkrouterc6u`](https://pypi.org/project/tplinkrouterc6u/).

---

## Estructura del Repositorio

```text
ha-tplink-be230/
├── custom_components/
│   └── tplink_be230/              # Integración Custom para Home Assistant
│       ├── __init__.py
│       ├── manifest.json
│       ├── const.py
│       ├── config_flow.py         # Configuración UI y cambio de contraseña
│       ├── coordinator.py         # Polling local y registro dinámico de dispositivos
│       ├── device_tracker.py      # Crea una entidad por cada dispositivo conectado
│       ├── sensor.py              # Sensores de estado del router + lista de clientes
│       ├── button.py              # Botón para reiniciar el router
│       ├── strings.json
│       └── translations/
│           ├── es.json
│           └── en.json
├── lovelace/
│   └── tplink-be230-card.js       # Widget Lovelace (custom:tplink-be230-card)
├── be230.py                       # Herramienta CLI para terminal
├── requirements.txt
├── .env.example
├── hacs.json
└── README.md
```

---

## 1. Integración de Home Assistant (`tplink_be230`)

### Características
* **Configuración 100% desde la interfaz de Home Assistant (Config Flow):**
  Permite configurar el **Host/IP** (`http://192.168.1.1`), la **contraseña local del router** y el **intervalo de escaneo** directamente desde la interfaz gráfica.
* **Cambio de contraseña en cualquier momento (Options Flow & Reauth):**
  Desde *Ajustes → Dispositivos y servicios → TP-Link Archer BE230 → Configurar*, puedes cambiar la contraseña que usa Home Assistant sin editar archivos YAML.
* **Creación automática de identidades (`device_tracker`):**
  Cada dispositivo conectado al router se registra automáticamente como una entidad `device_tracker.<nombre_o_mac>` con estado `home` / `not_home` y los siguientes atributos:
  * `ip`: Dirección IPv4 (`192.168.1.x`)
  * `mac`: Dirección MAC (`AA:BB:CC:DD:EE:FF`)
  * `hostname`: Nombre del equipo
  * `network`: Red a la que está conectado (`Wi-Fi 5GHz`, `Wi-Fi 2.4GHz`, `Wi-Fi 7 MLO`, `Ethernet (LAN)`, `Guest 5GHz`, `Guest 2.4GHz`, `IoT 2.4GHz`, `IoT 5GHz`)
  * `network_type`: Código interno (`host_5g`, `host_2g`, `host_mlo`, `wired`, `guest_5g`, `iot_2g`, etc.)
  * `band`: Banda (`5GHz`, `2.4GHz`, `6GHz`, `MLO`, `LAN`)
  * `signal`, `packets_sent`, `packets_received`, `down_speed`, `up_speed`, `last_seen`
* **Sensores y controles del Router:**
  * `sensor.tp_link_archer_be230_dispositivos_conectados` (con el listado completo en sus atributos)
  * `sensor.tp_link_archer_be230_ip_wan`
  * `sensor.tp_link_archer_be230_ip_lan`
  * `sensor.tp_link_archer_be230_uso_de_cpu`
  * `sensor.tp_link_archer_be230_uso_de_memoria`
  * `sensor.tp_link_archer_be230_clientes_wi_fi`
  * `sensor.tp_link_archer_be230_clientes_por_cable`
  * `button.tp_link_archer_be230_reiniciar_router`

### Instalación de la Integración en Home Assistant

1. Copia la carpeta `custom_components/tplink_be230` dentro del directorio `/config/custom_components/` de tu Home Assistant:
   ```bash
   cp -r custom_components/tplink_be230 /config/custom_components/
   ```
2. Reinicia Home Assistant.
3. Ve a **Ajustes → Dispositivos y servicios → Añadir integración** y busca **TP-Link Archer BE230**.
4. Ingresa:
   * **Host / IP:** `http://192.168.1.1`
   * **Contraseña local del Router:** *(tu contraseña de administración del BE230)*
   * **Intervalo de actualización:** `30` (segundos)

---

## 2. Widget Lovelace (`custom:tplink-be230-card`)

El archivo [`lovelace/tplink-be230-card.js`](./lovelace/tplink-be230-card.js) es un Web Component adaptable al tema de Home Assistant que descubre automáticamente las entidades creadas por la integración y muestra todos los dispositivos conectados.

### Funciones del Widget
* Muestra cada dispositivo con su **Nombre**, **IP** (clic para copiar), **MAC** (clic para copiar) y **Red conectada** (`Wi-Fi 5GHz`, `Wi-Fi 2.4GHz`, `Wi-Fi 7 MLO`, `Ethernet (LAN)`, `Guest`, `IoT`) diferenciada por colores.
* Al hacer clic sobre cualquier tarjeta de dispositivo, abre el diálogo de detalle (`more-info`) de su entidad `device_tracker` en Home Assistant.
* Barra superior de métricas del router (`IP LAN`, `IP WAN`, `% CPU`, `% RAM`, versión de firmware).
* Filtros rápidos por banda/red (`Activos`, `5GHz`, `2.4GHz`, `LAN`, `Guest/IoT`, `Todos`), buscador instantáneo por nombre/IP/MAC y modo `Compact` / `Grid`.

### Instalación del Widget
1. Copia `lovelace/tplink-be230-card.js` a `/config/www/tplink-be230-card.js` en tu Home Assistant.
2. En **Ajustes → Paneles de control → Recursos**, añade:
   * **URL:** `/local/tplink-be230-card.js?v=1`
   * **Tipo de recurso:** Módulo JavaScript
3. Añade la tarjeta en tu dashboard:

```yaml
# Versión Overview pequeña (para pestaña principal / Front)
type: custom:tplink-be230-card
title: Archer BE230 Overview
overview: true
detail_path: /dashboard-testdashboard/network

# Versión Detallada completa (para pestaña Network)
type: custom:tplink-be230-card
title: TP-Link Archer BE230
overview: false
compact: false
show_offline: false
```

---

## 3. CLI para Terminal (`be230.py`)

Puedes consultar o administrar el router directamente desde tu terminal en Linux:

```bash
cp .env.example .env
# Edita .env con tu contraseña local del router (TPLINK_PASSWORD=...)

# Ver estado completo (firmware, WAN/LAN, CPU/RAM y clientes conectados)
./be230.py

# Solo estado general
./be230.py status

# Solo dispositivos conectados
./be230.py devices

# Estado detallado IPv4 (DNS, máscara, gateway)
./be230.py ipv4

# Encender/apagar Wi-Fi (2g, 5g, guest2g, guest5g, iot2g, iot5g)
./be230.py wifi guest5g on

# Reiniciar el router
./be230.py reboot
```
