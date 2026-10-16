import ActivityKit
import SwiftUI
import WidgetKit

/// Must match BabyMonitorAttributes in modules/baby-native/ios/LiveActivity.swift field for field:
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

private let moonColor = Color(red: 1, green: 0.84, blue: 0.55)
private let nightBlue = Color(red: 0.08, green: 0.1, blue: 0.24)

private extension BabyMonitorAttributes.ContentState {
  var color: Color {
    switch status {
    case "live": .green
    case "warning": .orange
    default: .red
    }
  }
}

struct BabyMonitorLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: BabyMonitorAttributes.self) { context in
      LockScreenView(name: context.attributes.monitorName, state: context.state)
        .activityBackgroundTint(nightBlue)
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label {
            Text(context.state.title).font(.headline)
          } icon: {
            Image(systemName: "moon.stars.fill").foregroundStyle(moonColor)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          BatteryView(state: context.state)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 2) {
            if let detail = context.state.detail { Text(detail) }
            if let sound = context.state.sound { Text(sound).foregroundStyle(.secondary) }
          }
          .font(.subheadline)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Image(systemName: "moon.stars.fill").foregroundStyle(moonColor)
      } compactTrailing: {
        Circle().fill(context.state.color).frame(width: 10, height: 10)
      } minimal: {
        Image(systemName: "moon.stars.fill").foregroundStyle(context.state.color)
      }
      .keylineTint(moonColor)
    }
  }
}

private struct LockScreenView: View {
  let name: String
  let state: BabyMonitorAttributes.ContentState

  var body: some View {
    HStack(spacing: 14) {
      ZStack {
        Circle().fill(moonColor.opacity(0.18))
        Image(systemName: "moon.stars.fill").font(.title2).foregroundStyle(moonColor)
      }
      .frame(width: 48, height: 48)

      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Circle().fill(state.color).frame(width: 8, height: 8)
          Text(state.title).font(.headline)
          Text("· \(name)").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        }
        if let detail = state.detail { Text(detail).font(.subheadline) }
        if let sound = state.sound { Text(sound).font(.caption).foregroundStyle(.secondary) }
      }
      .foregroundStyle(.white)

      Spacer(minLength: 0)
      BatteryView(state: state)
    }
    .padding(16)
  }
}

private struct BatteryView: View {
  let state: BabyMonitorAttributes.ContentState

  var body: some View {
    if let battery = state.battery {
      Label {
        Text("\(battery)%").monospacedDigit()
      } icon: {
        Image(systemName: state.charging ? "battery.100.bolt" : battery <= 20 ? "battery.25" : "battery.75")
      }
      .font(.caption)
      .foregroundStyle(!state.charging && battery <= 20 ? .orange : .white)
    }
  }
}
