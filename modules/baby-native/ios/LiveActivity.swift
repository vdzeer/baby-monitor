import ActivityKit
import ExpoModulesCore
import Foundation

/// Must match BabyMonitorAttributes in targets/widget/BabyMonitorLiveActivity.swift field for field:
/// ActivityKit pairs the app's and the extension's copies by name and encoding.
struct BabyMonitorAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// "live" | "warning" | "offline"
    var status: String
    var title: String
    var detail: String?
    var sound: String?
    var battery: Int?
    var charging: Bool
  }

  var monitorName: String
}

/// What JS sends for the lock screen; texts arrive already translated.
struct LiveActivityState: Record {
  @Field var status: String = "live"
  @Field var title: String = ""
  @Field var detail: String?
  @Field var sound: String?
  @Field var battery: Int?
  @Field var charging: Bool = false

  var content: BabyMonitorAttributes.ContentState {
    .init(status: status, title: title, detail: detail, sound: sound, battery: battery, charging: charging)
  }
}

/// The parent's lock-screen / Dynamic Island status while it watches a baby unit.
@available(iOS 16.2, *)
enum LiveActivityController {
  private static var activity: Activity<BabyMonitorAttributes>?

  /// Starts the activity (only possible while the app is in the foreground) or updates it.
  static func update(monitorName: String, state: LiveActivityState) {
    let content = ActivityContent(state: state.content, staleDate: nil)
    if let activity, activity.activityState == .active, activity.attributes.monitorName == monitorName {
      Task { await activity.update(content) }
      return
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    endAll()
    activity = try? Activity.request(
      attributes: BabyMonitorAttributes(monitorName: monitorName), content: content, pushType: nil)
  }

  static func end() {
    activity = nil
    endAll()
  }

  /// Also ends leftovers from a previous launch, so there's never more than one.
  private static func endAll() {
    for activity in Activity<BabyMonitorAttributes>.activities {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
  }
}
