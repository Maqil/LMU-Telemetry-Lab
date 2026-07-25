"""Live telemetry sources (see ACC_REALTIME_TELEMETRY_DESIGN.md).

Every source turns a game's real-time interface into ``LiveFrame``s keyed by the
app's own channel names, so the ingestion service, the WebSocket and (later) the
DuckDB persister never learn which game/transport produced a sample.
"""
from .base import LiveFrame, LiveSource, world_to_latlon  # noqa: F401
