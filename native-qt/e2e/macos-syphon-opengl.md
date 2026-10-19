# Controlled OpenGL Syphon sender

`macos-syphon-opengl-fixture.mm` publishes rectangle textures using the OpenGL
Syphon API. The packaged app receives them through its Metal client. The fixture
uses the same deterministic color, alpha, moving-edge and frame-identity pattern
as the Metal fixture, so the existing browser and native OBS pixel oracles apply.
It captures no windows or devices and changes no system settings.

The October 18, 2026 workflows used the framework from upstream
[Syphon Simple](https://github.com/Syphon/Simple/tree/c500657ad3729bbea319fa43cb56e6564119665d),
with framework submodule `ef72eff3df5ab1f80e7156391e4443f5163e5158`.
This older OpenGL sender framework is separate from the app's Metal-capable
framework. A controlled generator is not an unmodified third-party sender.

From the repository root, supply the path to that built framework and a new
output directory. Its install name requires `Frameworks` adjacent to `bin`:

```sh
syphon_framework="/path/to/Simple Server.app/Contents/Frameworks/Syphon.framework"
fixture_out="/tmp/game-capture-opengl-fixture"
test ! -e "$fixture_out" || exit 1
mkdir -p "$fixture_out/bin" "$fixture_out/Frameworks"
cp -cR "$syphon_framework" "$fixture_out/Frameworks/Syphon.framework"
xcrun clang++ -std=c++20 -O2 -fobjc-arc -arch arm64 \
  -mmacosx-version-min=14.2 native-qt/e2e/macos-syphon-opengl-fixture.mm \
  -F"$(dirname "$syphon_framework")" \
  -framework AppKit -framework OpenGL -framework Syphon \
  -o "$fixture_out/bin/macos-syphon-opengl-fixture"
```

Build success is a gate only. Use a packaged app for the actual workflows:

```sh
node native-qt/e2e/macos-background-publish.js \
  --app="/path/to/Game Capture.app" \
  --fixture="$fixture_out/bin/macos-syphon-opengl-fixture" \
  --fixture-source=native-qt/e2e/macos-syphon-opengl-fixture.mm \
  --source=syphon --syphon-alpha=straight --flipped=false \
  --encoder=videotoolbox --reports=/path/to/new-reports
```

Run the eight combinations of `videotoolbox`/`x264`,
`straight`/`premultiplied`, and `--flipped=false`/`true` sequentially.
`flipped` reverses both the input rows and the corresponding API flag; the
received image must retain the same orientation and identity. Add
`--lifecycle=true --pause-seconds=25 --loss=retire` to exercise held-image,
late-viewer, resize/restore and sender-retirement behavior. Audio stays off.

`macos-alpha-publish.js` accepts the same fixture options plus `--codec=h264`,
`--receiver`, `--plugin` and `--plugin-data` for the existing native OBS receiver.
It verifies the separate VP9 alpha mask and actual black/white scene composition;
it does not launch the OBS frontend. Retain receiver/build provenance, numeric
observations, received snapshots and failures. Preserve the exact fixture source
with `--fixture-source` when substituting a sender.

The fixture also accepts newline-delimited `pause`, `resume`, `state`,
`resize WIDTH HEIGHT`, `retire`, `restart` and `quit` on stdin. EOF stops its owned
server. Only the fixture uses this protocol; these are not VDO.Ninja API calls.

[Released-app results and limits](https://github.com/steveseguin/game-capture/blob/main/docs/macos-0265-beta1-validation-2026-10-18.md#opengl-syphon-interoperability-follow-up).
