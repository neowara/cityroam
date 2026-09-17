<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
  <img src="docs/logo.png" alt="Cityroam" height="60">
</picture>

Cityroam is an Android app that records rides on Tynee electric skateboards and NAVEE
scooters. It talks to the board directly over Bluetooth for battery, voltage, odometer
and ride mode, records the route with the phone's GPS, and can change the board's own
settings. Finished rides sync to a server and, if you allow it, to Health Connect.

More detail is in [`docs/index.md`](docs/index.md).

## Status

- Android only.
- Boards: Tynee skateboards and NAVEE scooters that use the protocols this app speaks.
  NAVEE's V40i Pro is the model it was developed against. Other models are untested.
- Not on Google Play. Releases are APKs on the releases page, or build it yourself.
- The default server is the maintainer's and accounts on it are invite-only. Point the app
  at your own server to run it without one.

## Screenshots

<sub>Scroll sideways to see them all.</sub>

<table>
  <tr>
    <td><img src="docs/screenshots/dashboard-1.jpeg" height="640" alt="Dashboard"></td>
    <td><img src="docs/screenshots/dashboard-2.jpeg" height="640" alt="Dashboard"></td>
    <td><img src="docs/screenshots/rides.jpeg" height="640" alt="Rides"></td>
    <td><img src="docs/screenshots/activity.jpeg" height="640" alt="Activity"></td>
    <td><img src="docs/screenshots/plan-1.jpeg" height="640" alt="Route planner"></td>
    <td><img src="docs/screenshots/plan-2.jpeg" height="640" alt="Route planner"></td>
    <td><img src="docs/screenshots/plan-3.jpeg" height="640" alt="Route planner"></td>
    <td><img src="docs/screenshots/trip-detail-1.jpeg" height="640" alt="Trip detail"></td>
    <td><img src="docs/screenshots/trip-detail-2.jpeg" height="640" alt="Trip detail"></td>
    <td><img src="docs/screenshots/settings.jpeg" height="640" alt="Settings"></td>
    <td><img src="docs/screenshots/settings-board-connection.jpeg" height="640" alt="Settings / Board & Connection"></td>
    <td><img src="docs/screenshots/settings-ride-tracking.jpeg" height="640" alt="Settings / Ride Tracking"></td>
    <td><img src="docs/screenshots/settings-notifications.jpeg" height="640" alt="Settings / Notifications"></td>
    <td><img src="docs/screenshots/settings-health-data.jpeg" height="640" alt="Settings / Health & Data"></td>
    <td><img src="docs/screenshots/settings-appearance.jpeg" height="640" alt="Settings / Appearance"></td>
    <td><img src="docs/screenshots/settings-advanced.jpeg" height="640" alt="Settings / Advanced"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>Dashboard</b></sub></td>
    <td align="center"><sub><b>Rides</b></sub></td>
    <td align="center"><sub><b>Activity</b></sub></td>
    <td colspan="3" align="center"><sub><b>Route planner</b></sub></td>
    <td colspan="2" align="center"><sub><b>Trip detail</b></sub></td>
    <td align="center"><sub><b>Settings</b></sub></td>
    <td align="center"><sub><b>Settings / Board &amp; Connection</b></sub></td>
    <td align="center"><sub><b>Settings / Ride Tracking</b></sub></td>
    <td align="center"><sub><b>Settings / Notifications</b></sub></td>
    <td align="center"><sub><b>Settings / Health &amp; Data</b></sub></td>
    <td align="center"><sub><b>Settings / Appearance</b></sub></td>
    <td align="center"><sub><b>Settings / Advanced</b></sub></td>
  </tr>
</table>

## Getting started

The app lives in [`mobile/`](mobile/). It uses native modules that Expo Go doesn't include,
so you need a development build on a device or emulator.

```bash
cd mobile
npm install
cp .env.example .env    # set EXPO_PUBLIC_DEFAULT_SERVER_ADDRESS
npm run android
```

The server is not part of this repository. See [`mobile/README.md`](mobile/README.md) for
setup, checks and the project layout.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Contributions are by invitation.

Bug reports and feature requests are welcome through the issue forms. Anything security
related belongs in [`SECURITY.md`](SECURITY.md) rather than a public issue. Everyone
taking part is expected to follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Licence

The source is public so people can see how the app works. It is not open source.
Cityroam is licensed under the [PolyForm Strict License 1.0.0](LICENSE), which allows
personal, noncommercial use of the code as it is and nothing more: no changes, no
redistribution, no publishing your own build. For anything else, ask first.
Third-party dependencies keep their own licences.

## Contact

[@neowara](https://github.com/neowara) on GitHub, or [cityroamapp@casa-verde.casa](mailto:cityroamapp@casa-verde.casa).

Cityroam is not affiliated with any board manufacturer. See [`TRADEMARKS.md`](TRADEMARKS.md).
