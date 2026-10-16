#!/usr/bin/env bash
# Builds the app and uploads it to TestFlight using the Apple account signed in to Xcode.
#   npm run testflight             → archive + upload
#   npm run testflight -- export   → archive + sign locally, no upload
set -euo pipefail
cd "$(dirname "$0")/.."

DESTINATION="${1:-upload}"
# Your Apple team: set APPLE_TEAM_ID (app.config.js reads it too), or change both defaults
# (here and ios.appleTeamId in app.json).
TEAM_ID="${APPLE_TEAM_ID:-RV38A3JNTT}"
OUT="build/testflight"

npx expo prebuild --platform ios
rm -rf "$OUT"
mkdir -p "$OUT"

# The Xcode project is named after "name" in app.json.
WORKSPACE="$(ls -d ios/*.xcworkspace | head -1)"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
ARCHIVE="$OUT/$SCHEME.xcarchive"

xcodebuild archive -quiet \
  -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${DESTINATION}</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <!-- Xcode picks the next free build number on upload, so nothing needs bumping by hand. -->
  <key>manageAppVersionAndBuildNumber</key><true/>
  <!-- No testFlightInternalTestingOnly: builds marked with it can never be submitted to the App Store. -->
</dict>
</plist>
PLIST

xcodebuild -exportArchive -quiet \
  -archivePath "$ARCHIVE" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" -allowProvisioningUpdates

echo "Done ($DESTINATION)."
