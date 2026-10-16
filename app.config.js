// app.json holds the app config. This file only lets you sign with your own Apple team
// without editing it: Expo passes app.json in as `config`.
//
//   APPLE_TEAM_ID=ABCDE12345 IOS_BUNDLE_ID=com.example.babymonitor npx expo prebuild --clean
//
// Without these variables the values in app.json are used unchanged.
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    appleTeamId: process.env.APPLE_TEAM_ID || config.ios.appleTeamId,
    bundleIdentifier: process.env.IOS_BUNDLE_ID || config.ios.bundleIdentifier,
  },
});
