import Foundation

enum ProjectIconEmoji {
    static func first(in text: String) -> String? {
        text.first(where: { character in
            character.unicodeScalars.contains { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x7F) }
        }).map(String.init)
    }
}
