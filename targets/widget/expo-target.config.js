/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = () => ({
  type: 'widget',
  name: 'LiveActivity',
  displayName: 'Moonbeam',
  icon: '../../assets/icon.png',
  // Live Activities need iOS 16.2.
  deploymentTarget: '16.2',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
});
