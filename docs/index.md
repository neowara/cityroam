# How Cityroam works

## Recording

Rides are recorded automatically. The board's wheel speed starts a ride, and the ride
ends when the board stops moving for a while or switches off. There is also a manual
start and stop.

Recording has to survive a phone in a pocket: the app backgrounded, the process killed,
the Bluetooth link dropping for a moment. Three things cover that:

- A foreground service (`RideService`) keeps a native ride journal of GPS points and
  board telemetry in SQLite, independent of the JavaScript runtime. Saved trips take
  their route from this journal.
- Reconnection is layered: a WorkManager job, `expo-background-task`, and a
  system-held Bluetooth scan that can wake the app after its process was killed.
- An optional home geofence wakes the app when you leave home so it can reconnect
  before you reach the board. It never starts a ride.

[ADR 0006](adr/0006-native-ride-recording-and-reconnection.md) has the full reasoning.

## Where data comes from

- **Phone:** GPS only. There is no GPS watch while idle; it starts when the board
  connects.
- **Board:** speed, battery, voltage, ride mode and odometer over Bluetooth.
- **External services:** weather (Open-Meteo), routing and map matching (OSRM),
  address search (Photon).

## Saving and syncing

A finished trip is written to a local SQLite queue before any network call, so a ride
is never lost to a dead zone. Unsynced trips show up everywhere synced ones do, with a
small badge. Sync retries after each ride, at launch and whenever the app returns to
the foreground. Finished rides can also be written to Health Connect as exercise
sessions with their route.

## Screens

- **Dashboard:** this week's totals, connection status, last ride, range estimate.
- **Rides:** ride history.
- **Activity:** day, week and month charts.
- **Plan:** pick a destination and see, per ride mode, whether the battery will get
  you there.
- **Trip detail:** map, mode breakdown, voltage graph, weather along the route and
  Health Connect vitals.
- **Board settings:** pairing and the board's own settings, such as speed limits and
  acceleration. Changes made while the board is offline are applied when it reconnects.
- **Settings:** account, connection, tracking, notifications, Health Connect,
  appearance, widget, debug tools.

## Further reading

- [`context.md`](context.md): the terms used in the code and docs.
- [`adr/`](adr/): architecture decisions.
- [`../mobile/README.md`](../mobile/README.md): setup, checks and project layout.
- [`../mobile/modules/board-ble/DATAPOINTS.md`](../mobile/modules/board-ble/DATAPOINTS.md): the board's Bluetooth datapoints.
