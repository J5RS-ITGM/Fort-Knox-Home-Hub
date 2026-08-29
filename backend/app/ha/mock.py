"""Mock Home Assistant bridge.

Simulates the actual planned device roster (Zooz contacts/motion/leak, Schlage
lock, ZEN15 pool pump, ESPHome Midea mini-split, WLED, Frigate person events,
ZAC36 spigot valve, sump CT sensor) so the frontend can be developed and
demoed with realistic data before the hub exists. Service calls mutate local
state, so the dashboard is fully interactive in mock mode.
"""

import asyncio
import logging
import random
from datetime import datetime, timezone
from typing import Any

from .state import Entity, cache

log = logging.getLogger("homehub.mock")


def _now() -> datetime:
    return datetime.now(timezone.utc)


SEED: list[dict[str, Any]] = [
    # Alarm
    {"entity_id": "alarm_control_panel.homehub", "state": "disarmed",
     "attributes": {"friendly_name": "HomeHub Alarm", "supported_modes": ["armed_home", "armed_away"]}},
    # Contacts — Zooz ZSE41
    {"entity_id": "binary_sensor.front_door_contact", "state": "off",
     "attributes": {"friendly_name": "Front Door", "device_class": "door", "model": "Zooz ZSE41", "battery": 96}},
    {"entity_id": "binary_sensor.back_door_contact", "state": "off",
     "attributes": {"friendly_name": "Back Door", "device_class": "door", "model": "Zooz ZSE41", "battery": 92}},
    {"entity_id": "binary_sensor.garage_entry_contact", "state": "off",
     "attributes": {"friendly_name": "Garage Entry", "device_class": "door", "model": "Zooz ZSE41", "battery": 88}},
    {"entity_id": "binary_sensor.kitchen_window_contact", "state": "off",
     "attributes": {"friendly_name": "Kitchen Window", "device_class": "window", "model": "Zooz ZSE41", "battery": 99}},
    {"entity_id": "binary_sensor.basement_window_contact", "state": "off",
     "attributes": {"friendly_name": "Basement Window", "device_class": "window", "model": "Zooz ZSE41", "battery": 94}},
    # Motion — Zooz ZSE18
    {"entity_id": "binary_sensor.hallway_motion", "state": "off",
     "attributes": {"friendly_name": "Hallway Motion", "device_class": "motion", "model": "Zooz ZSE18", "battery": 90}},
    {"entity_id": "binary_sensor.basement_motion", "state": "off",
     "attributes": {"friendly_name": "Basement Motion", "device_class": "motion", "model": "Zooz ZSE18", "battery": 85}},
    # Leak — Zooz ZSE42
    {"entity_id": "binary_sensor.water_heater_leak", "state": "off",
     "attributes": {"friendly_name": "Water Heater Leak", "device_class": "moisture", "model": "Zooz ZSE42", "battery": 97}},
    {"entity_id": "binary_sensor.laundry_leak", "state": "off",
     "attributes": {"friendly_name": "Laundry Leak", "device_class": "moisture", "model": "Zooz ZSE42", "battery": 95}},
    {"entity_id": "binary_sensor.sump_pit_leak", "state": "off",
     "attributes": {"friendly_name": "Sump Pit Leak", "device_class": "moisture", "model": "Zooz ZSE42", "battery": 93}},
    # Smoke/CO bridge — Ecolink FireFighter
    {"entity_id": "binary_sensor.smoke_co_bridge", "state": "off",
     "attributes": {"friendly_name": "Smoke / CO", "device_class": "smoke", "model": "Ecolink FireFighter"}},
    # Lock — Schlage BE469ZP
    {"entity_id": "lock.front_door", "state": "locked",
     "attributes": {"friendly_name": "Front Door Lock", "model": "Schlage BE469ZP", "battery": 82}},
    # Pool pump — Zooz ZEN15 (power metering)
    {"entity_id": "switch.pool_pump", "state": "on",
     "attributes": {"friendly_name": "Pool Pump", "model": "Zooz ZEN15", "power_w": 1180}},
    # Sump pump CT sensor — ESP32
    {"entity_id": "sensor.sump_pump_current", "state": "0.2",
     "attributes": {"friendly_name": "Sump Pump Current", "unit_of_measurement": "A", "model": "ESP32 + CT"}},
    # Outdoor spigot — Zooz ZAC36 Titan
    {"entity_id": "valve.outdoor_spigot", "state": "closed",
     "attributes": {"friendly_name": "Outdoor Spigot", "model": "Zooz ZAC36 Titan"}},
    # Climate
    {"entity_id": "climate.main_floor", "state": "heat_cool",
     "attributes": {"friendly_name": "Main Floor HVAC", "current_temperature": 71.5,
                    "target_temp_low": 68, "target_temp_high": 74, "hvac_action": "idle"}},
    {"entity_id": "climate.garage_minisplit", "state": "cool",
     "attributes": {"friendly_name": "Garage Mini-Split", "current_temperature": 77.0,
                    "temperature": 74, "hvac_action": "cooling", "model": "Mr. Cool + ESPHome"}},
    # Lights
    {"entity_id": "light.kitchen_cabinets", "state": "on",
     "attributes": {"friendly_name": "Kitchen Cabinet WLED", "brightness": 180, "model": "WLED WS2815"}},
    {"entity_id": "light.living_room", "state": "off",
     "attributes": {"friendly_name": "Living Room", "model": "Zooz ZEN72"}},
    {"entity_id": "light.front_porch", "state": "off",
     "attributes": {"friendly_name": "Front Porch", "model": "Zooz ZEN71"}},
    # Frigate person detection
    {"entity_id": "binary_sensor.driveway_person", "state": "off",
     "attributes": {"friendly_name": "Driveway Person", "device_class": "occupancy", "source": "Frigate"}},
    # Environment
    {"entity_id": "sensor.basement_humidity", "state": "48",
     "attributes": {"friendly_name": "Basement Humidity", "unit_of_measurement": "%"}},
]


class MockHA:
    """Drop-in stand-in for HAClient with the same public surface."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="mock-ha")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await cache.set_connected(False)

    async def _run(self) -> None:
        for raw in SEED:
            await cache.apply(
                Entity(entity_id=raw["entity_id"], state=raw["state"], attributes=dict(raw["attributes"])),
                broadcast=False,
            )
        await cache.set_connected(True)
        log.info("Mock HA seeded %d entities", len(cache))

        while not self._stop.is_set():
            await asyncio.sleep(random.uniform(4, 9))
            await self._tick()

    async def _tick(self) -> None:
        roll = random.random()
        if roll < 0.30:
            await self._pulse_motion(random.choice(["binary_sensor.hallway_motion", "binary_sensor.basement_motion"]))
        elif roll < 0.45:
            await self._pulse_motion("binary_sensor.driveway_person", clear_after=8)
        elif roll < 0.65:
            await self._drift_climate()
        elif roll < 0.85:
            await self._drift_power()
        else:
            await self._drift_humidity()

    async def _pulse_motion(self, entity_id: str, clear_after: float = 15.0) -> None:
        ent = cache.get(entity_id)
        if not ent or ent.state == "on":
            return
        await cache.apply(Entity(entity_id, "on", dict(ent.attributes)))

        async def _clear() -> None:
            await asyncio.sleep(clear_after)
            cur = cache.get(entity_id)
            if cur and cur.state == "on":
                await cache.apply(Entity(entity_id, "off", dict(cur.attributes)))

        asyncio.create_task(_clear())

    async def _drift_climate(self) -> None:
        for eid in ("climate.main_floor", "climate.garage_minisplit"):
            ent = cache.get(eid)
            if not ent:
                continue
            attrs = dict(ent.attributes)
            cur = float(attrs.get("current_temperature", 72))
            attrs["current_temperature"] = round(cur + random.uniform(-0.4, 0.4), 1)
            await cache.apply(Entity(eid, ent.state, attrs))

    async def _drift_power(self) -> None:
        ent = cache.get("switch.pool_pump")
        if ent:
            attrs = dict(ent.attributes)
            attrs["power_w"] = 0 if ent.state == "off" else int(1180 + random.uniform(-60, 60))
            await cache.apply(Entity(ent.entity_id, ent.state, attrs))
        sump = cache.get("sensor.sump_pump_current")
        if sump:
            running = random.random() < 0.12
            value = round(random.uniform(5.5, 7.5), 1) if running else round(random.uniform(0.0, 0.3), 1)
            await cache.apply(Entity(sump.entity_id, str(value), dict(sump.attributes)))

    async def _drift_humidity(self) -> None:
        ent = cache.get("sensor.basement_humidity")
        if ent:
            value = max(35, min(65, int(float(ent.state)) + random.choice([-1, 0, 1])))
            await cache.apply(Entity(ent.entity_id, str(value), dict(ent.attributes)))

    # -- interactive service calls (local mutation) ---------------------------
    async def call_service(self, domain: str, service: str, entity_id: str, data: dict[str, Any]) -> None:
        ent = cache.get(entity_id)
        if not ent:
            raise ValueError(f"unknown entity: {entity_id}")
        state = ent.state
        attrs = dict(ent.attributes)

        if domain in ("switch", "light"):
            if service == "turn_on":
                state = "on"
            elif service == "turn_off":
                state = "off"
            elif service == "toggle":
                state = "off" if state == "on" else "on"
        elif domain == "lock":
            state = "locked" if service == "lock" else "unlocked"
        elif domain == "valve":
            state = "open" if service == "open_valve" else "closed"
        elif domain == "alarm_control_panel":
            mapping = {
                "alarm_disarm": "disarmed",
                "alarm_arm_home": "armed_home",
                "alarm_arm_away": "armed_away",
            }
            state = mapping.get(service, state)
        elif domain == "climate" and service == "set_temperature":
            attrs.update({k: v for k, v in data.items() if k in ("temperature", "target_temp_low", "target_temp_high")})

        await cache.apply(Entity(entity_id, state, attrs))
