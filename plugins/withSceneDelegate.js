const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

/**
 * iOS 27 refuses to launch apps built with its SDK unless they adopt the UIScene life cycle
 * (crash in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
 * Expo SDK 58 templates do this out of the box; this backports the same setup to SDK 57
 * using Expo's own ExpoAppSceneDelegate. Remove this plugin after upgrading to SDK 58.
 */
module.exports = function withSceneDelegate(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return config;
  });

  return withAppDelegate(config, (config) => {
    let contents = config.modResults.contents;
    if (contents.includes('ExpoAppSceneDelegate')) return config;

    const replace = (pattern, replacement) => {
      const next = contents.replace(pattern, replacement);
      if (next === contents) throw new Error(`withSceneDelegate: AppDelegate.swift no longer matches ${pattern}`);
      contents = next;
    };

    replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
    // The scene delegate creates the window and starts React Native instead.
    replace(/\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)[\s\S]*?#endif\n/, '');
    contents += '\n@objc(SceneDelegate)\nclass SceneDelegate: ExpoAppSceneDelegate {}\n';

    config.modResults.contents = contents;
    return config;
  });
};
