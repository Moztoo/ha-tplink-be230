"""Config flow for TP-Link Archer BE230 integration."""
from __future__ import annotations

import logging
from typing import Any

from tplinkrouterc6u import TplinkRouterProvider
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

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
)

_LOGGER = logging.getLogger(__name__)


def _validate_router_sync(
    host: str, password: str, username: str, verify_ssl: bool
) -> dict[str, str]:
    """Validate router connection and credentials in executor."""
    if not host.startswith("http://") and not host.startswith("https://"):
        host = f"http://{host}"

    router = TplinkRouterProvider.get_client(
        host, password, username, _LOGGER, verify_ssl
    )
    try:
        router.authorize()
        fw = router.get_firmware()
        status = router.get_status()
        return {
            "host": host,
            "model": getattr(fw, "model", None) or "Archer BE230",
            "mac": str(getattr(status, "lan_macaddr", "")) or host,
        }
    finally:
        try:
            router.logout()
        except Exception:
            pass


async def _async_validate_input(
    hass: HomeAssistant, data: dict[str, Any]
) -> dict[str, str]:
    """Validate user input allows us to connect and authenticate."""
    host = data[CONF_HOST].strip()
    password = data[CONF_PASSWORD]
    username = data.get(CONF_USERNAME, DEFAULT_USERNAME).strip() or DEFAULT_USERNAME
    verify_ssl = bool(data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL))
    return await hass.async_add_executor_job(
        _validate_router_sync, host, password, username, verify_ssl
    )


class TplinkBE230ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for TP-Link Archer BE230."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize config flow."""
        self._reauth_entry: config_entries.ConfigEntry | None = None

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step configured via the Home Assistant UI."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                info = await _async_validate_input(self.hass, user_input)
            except Exception as err:
                _LOGGER.warning("Failed to connect to TP-Link BE230: %s", err)
                err_str = str(err).lower()
                if "login" in err_str or "auth" in err_str or "password" in err_str or "incorrect" in err_str:
                    errors["base"] = "invalid_auth"
                else:
                    errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(info["mac"])
                self._abort_if_unique_id_configured()
                user_input[CONF_HOST] = info["host"]
                return self.async_create_entry(
                    title=f"TP-Link {info['model']} ({info['host']})",
                    data=user_input,
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=DEFAULT_HOST): TextSelector(
                    TextSelectorConfig(type=TextSelectorType.TEXT)
                ),
                vol.Required(CONF_PASSWORD): TextSelector(
                    TextSelectorConfig(type=TextSelectorType.PASSWORD)
                ),
                vol.Optional(CONF_USERNAME, default=DEFAULT_USERNAME): TextSelector(
                    TextSelectorConfig(type=TextSelectorType.TEXT)
                ),
                vol.Optional(CONF_VERIFY_SSL, default=DEFAULT_VERIFY_SSL): bool,
                vol.Optional(
                    CONF_SCAN_INTERVAL, default=DEFAULT_SCAN_INTERVAL
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=10, max=600, step=5, mode=NumberSelectorMode.BOX
                    )
                ),
            }
        )

        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: dict[str, Any]
    ) -> FlowResult:
        """Perform reauth upon an API authentication error."""
        self._reauth_entry = self.hass.config_entries.async_get_entry(
            self.context["entry_id"]
        )
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Dialog that informs the user that reauth is required."""
        errors: dict[str, str] = {}
        assert self._reauth_entry is not None

        if user_input is not None:
            merged = {**self._reauth_entry.data, **self._reauth_entry.options, **user_input}
            try:
                await _async_validate_input(self.hass, merged)
            except Exception:
                errors["base"] = "invalid_auth"
            else:
                self.hass.config_entries.async_update_entry(
                    self._reauth_entry,
                    data={**self._reauth_entry.data, CONF_PASSWORD: user_input[CONF_PASSWORD]},
                    options={**self._reauth_entry.options, CONF_PASSWORD: user_input[CONF_PASSWORD]},
                )
                await self.hass.config_entries.async_reload(self._reauth_entry.entry_id)
                return self.async_abort(reason="reauth_successful")

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_PASSWORD): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.PASSWORD)
                    ),
                }
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        """Get the options flow for this handler (allows changing password & interval)."""
        return TplinkBE230OptionsFlowHandler(config_entry)


class TplinkBE230OptionsFlowHandler(config_entries.OptionsFlow):
    """Handle options flow for TP-Link Archer BE230 (change password, host, scan interval)."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize options flow."""
        self._config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Manage the options."""
        errors: dict[str, str] = {}

        current_host = self._config_entry.options.get(
            CONF_HOST, self._config_entry.data.get(CONF_HOST, DEFAULT_HOST)
        )
        current_password = self._config_entry.options.get(
            CONF_PASSWORD, self._config_entry.data.get(CONF_PASSWORD, "")
        )
        current_username = self._config_entry.options.get(
            CONF_USERNAME, self._config_entry.data.get(CONF_USERNAME, DEFAULT_USERNAME)
        )
        current_verify_ssl = self._config_entry.options.get(
            CONF_VERIFY_SSL,
            self._config_entry.data.get(CONF_VERIFY_SSL, DEFAULT_VERIFY_SSL),
        )
        current_scan_interval = self._config_entry.options.get(
            CONF_SCAN_INTERVAL,
            self._config_entry.data.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
        )

        if user_input is not None:
            try:
                info = await _async_validate_input(self.hass, user_input)
            except Exception as err:
                _LOGGER.warning("Failed to validate updated BE230 options: %s", err)
                err_str = str(err).lower()
                if "login" in err_str or "auth" in err_str or "password" in err_str:
                    errors["base"] = "invalid_auth"
                else:
                    errors["base"] = "cannot_connect"
            else:
                user_input[CONF_HOST] = info["host"]
                return self.async_create_entry(title="", data=user_input)

        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=current_host): TextSelector(
                    TextSelectorConfig(type=TextSelectorType.TEXT)
                ),
                vol.Required(CONF_PASSWORD, default=current_password): TextSelector(
                    TextSelectorConfig(type=TextSelectorType.PASSWORD)
                ),
                vol.Optional(CONF_USERNAME, default=current_username): TextSelector(
                    TextSelectorConfig(type=TextSelectorType.TEXT)
                ),
                vol.Optional(CONF_VERIFY_SSL, default=current_verify_ssl): bool,
                vol.Optional(
                    CONF_SCAN_INTERVAL, default=current_scan_interval
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=10, max=600, step=5, mode=NumberSelectorMode.BOX
                    )
                ),
            }
        )

        return self.async_show_form(
            step_id="init",
            data_schema=schema,
            errors=errors,
        )
