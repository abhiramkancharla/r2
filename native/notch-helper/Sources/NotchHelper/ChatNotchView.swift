import SwiftUI

/// The expanded notch surface. Pure UI for now — no LLM, no history, no
/// loading state. Just an input field and a Send button. Pressing Return
/// inside the field or clicking Send invokes `onSend(text)`.
struct ChatNotchView: View {
    var onSend: (String) -> Void

    @State private var text: String = ""
    @FocusState private var focused: Bool

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var canSend: Bool { !trimmed.isEmpty }

    var body: some View {
        HStack(spacing: 10) {
            // Small marker dot — gives the chat bar a subtle "presence"
            // anchor that lines up with the eye orb's identity.
            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color.white.opacity(0.95), Color.white.opacity(0.35)],
                        center: .topLeading,
                        startRadius: 0,
                        endRadius: 8
                    )
                )
                .frame(width: 8, height: 8)
                .shadow(color: .white.opacity(0.4), radius: 3)

            TextField("Ask R2…", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 13, weight: .regular, design: .default))
                .foregroundStyle(.white)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color.white.opacity(0.07))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(Color.white.opacity(0.16), lineWidth: 1)
                )
                .onSubmit(submit)

            Button(action: submit) {
                ZStack {
                    Circle()
                        .fill(canSend ? Color.white.opacity(0.95) : Color.white.opacity(0.15))
                    Image(systemName: "arrow.up")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(canSend ? .black : .white.opacity(0.4))
                }
                .frame(width: 26, height: 26)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .animation(.easeInOut(duration: 0.15), value: canSend)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minWidth: 380, idealWidth: 420, maxWidth: 480)
        .onAppear {
            // Slight delay so the notch expansion animation completes before
            // we steal focus — feels more "the notch invited you" instead of
            // a window grabbing input.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                focused = true
            }
        }
    }

    private func submit() {
        guard canSend else { return }
        onSend(trimmed)
        text = ""
    }
}
