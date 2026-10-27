"""The manifest an agent sends when it starts (SPEC section 6.2), and checking the values
people set for its settings in the Hub.

The Hub builds each agent's settings form from its manifest, so adding an agent never needs
a change to the Hub.
"""

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app import connections

SettingKey = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,39}$")]
Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]


class Setting(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: SettingKey
    type: Literal["int", "float", "text", "bool", "choice"]
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    help: Text = ""
    default: int | float | str | bool | None = None
    min: float | None = None
    max: float | None = None
    choices: list[str] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def _consistent(self) -> "Setting":
        if self.type == "choice" and not self.choices:
            raise ValueError(f"{self.key}: a choice setting needs choices")
        if self.default is not None:
            problem = check_value(self, self.default)
            if problem:
                raise ValueError(f"{self.key}: default {problem}")
        return self


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    version: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    description: Text = ""
    settings: list[Setting] = Field(default_factory=list, max_length=60)
    # Connection groups whose values the agent receives when a run starts.
    connections: list[str] = Field(default_factory=list)
    # The Master Sheet columns the agent writes, e.g. "GBP Status".
    sheet_columns: list[Annotated[str, StringConstraints(max_length=60)]] = Field(
        default_factory=list, max_length=20
    )
    cost_per_item_usd: float = Field(default=0.0, ge=0, le=100)

    @model_validator(mode="after")
    def _known(self) -> "Manifest":
        unknown = [name for name in self.connections if name not in connections.GROUPS]
        if unknown:
            raise ValueError(f"unknown connections: {', '.join(unknown)}")
        keys = [setting.key for setting in self.settings]
        if len(keys) != len(set(keys)):
            raise ValueError("setting keys must be unique")
        return self


def check_value(setting: Setting, value: Any) -> str | None:
    """Why a value doesn't suit a setting, or None."""
    if setting.type == "bool":
        return None if isinstance(value, bool) else "must be on or off"
    if setting.type in ("int", "float"):
        if isinstance(value, bool) or not isinstance(value, int | float):
            return "must be a number"
        if setting.type == "int" and not float(value).is_integer():
            return "must be a whole number"
        if setting.min is not None and value < setting.min:
            return f"must be at least {_number(setting.min)}"
        if setting.max is not None and value > setting.max:
            return f"must be at most {_number(setting.max)}"
        return None
    if not isinstance(value, str):
        return "must be text"
    if setting.type == "choice" and value not in setting.choices:
        return f"must be one of: {', '.join(setting.choices)}"
    if len(value) > 2000:
        return "is too long"
    return None


def _number(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def effective_config(manifest: Manifest | None, saved: dict[str, Any]) -> dict[str, Any]:
    """Every setting's value: what was saved in the Hub, otherwise the manifest's default.
    Values saved for settings the manifest no longer has are kept but not used."""
    if manifest is None:
        return {}
    out: dict[str, Any] = {}
    for setting in manifest.settings:
        value = saved.get(setting.key, setting.default)
        if value is not None and check_value(setting, value) is not None:
            value = setting.default  # a newer manifest narrowed the range: fall back
        if setting.type == "int" and isinstance(value, float):
            value = int(value)
        out[setting.key] = value
    return out


RUN_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
AGENT_KEY = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
