import Foundation

/// Append by stream position even when retained history rolls past the byte cap.
/// A renderer that missed the retained tail, or a new attach/clear, replays once.
enum TerminalOutputReplay {
    enum Update: Equatable {
        case none
        case append(Data)
        case reset
    }

    static func update(buffer: String, cursor: FeatureTerminalOutputCursor?,
                       previousBuffer: String, previousCursor: FeatureTerminalOutputCursor?) -> Update {
        guard let cursor else {
            if buffer == previousBuffer { return .none }
            return buffer.hasPrefix(previousBuffer)
                ? .append(Data(buffer.dropFirst(previousBuffer.count).utf8)) : .reset
        }
        guard let previousCursor, previousCursor.generation == cursor.generation else { return .reset }
        let unread = cursor.byteOffset - previousCursor.byteOffset
        guard unread >= 0, unread <= buffer.utf8.count else { return .reset }
        if unread == 0 { return .none }
        return .append(Data(buffer.utf8.suffix(unread)))
    }
}
