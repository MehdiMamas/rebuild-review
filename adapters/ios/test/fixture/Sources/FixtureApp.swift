import SwiftUI
import os

@main
struct FixtureApp: App {
    var body: some Scene {
        WindowGroup {
            if CommandLine.arguments.contains("-RRSignIn") {
                SignInView()
            } else {
                HomeView()
            }
        }
    }
}

// Sign-in at launch: nothing leads past this screen without an account.
struct SignInView: View {
    @State private var user = ""
    @State private var pass = ""
    var body: some View {
        VStack(spacing: 16) {
            Text("Sign in")
            TextField("Username", text: $user).textFieldStyle(.roundedBorder)
            SecureField("Password", text: $pass).textFieldStyle(.roundedBorder)
            Button(action: {}) { Text("Sign in").frame(minWidth: 44, minHeight: 44) }
        }
        .padding()
    }
}

struct HomeView: View {
    @State private var showDetails = false
    @State private var fetched = ""
    var body: some View {
        NavigationStack {
            ZStack {
                Color.clear
                VStack(spacing: 18) {
                    Text("Fixture Home")
                    NavigationLink { ListView() } label: { Text("Open List").frame(minWidth: 44, minHeight: 44) }
                    NavigationLink { SettingsView() } label: { Text("Open Settings").frame(minWidth: 44, minHeight: 44) }
                    Button(action: { showDetails = true }) { Text("Show Details").frame(minWidth: 44, minHeight: 44) }
                    Button(action: { fetch() }) { Text("Fetch").frame(minWidth: 44, minHeight: 44) }
                    // Planted: a 30 pt tap target.
                    Button(action: {}) { Text("Tiny").frame(width: 30, height: 30) }
                    // Planted: a button with no label.
                    Button(action: {}) { Rectangle().fill(Color.blue).frame(width: 44, height: 44) }
                    // Planted: a button that crashes the app.
                    Button(action: { fatalError("planted crash") }) { Text("Crash").frame(minWidth: 44, minHeight: 44) }
                }
                // Planted: a control inside the status bar band.
                Button(action: {}) { Text("Menu").frame(width: 60, height: 44) }.position(x: 60, y: 30)
            }
            .ignoresSafeArea()
            .sheet(isPresented: $showDetails) { DetailsView() }
            .onAppear { Logger(subsystem: "example.rrfixture.app", category: "main").error("token tok_0123456789abcdef0123456789abcdef0123 loaded") }
        }
    }
    // Opens a connection to the address in the environment, when there is one (the network check reads the hit count).
    func fetch() {
        guard let s = ProcessInfo.processInfo.environment["RR_FIXTURE_URL"], let u = URL(string: s) else { fetched = "no address"; return }
        URLSession.shared.dataTask(with: u) { d, _, _ in
            DispatchQueue.main.async { fetched = d == nil ? "failed" : "loaded" }
        }.resume()
    }
}

struct ListView: View {
    var body: some View {
        List(["Milk", "Eggs", "Bread"], id: \.self) { Text($0) }
            .navigationTitle("Items")
    }
}

struct SettingsView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Planted: wider than the screen at the largest text sizes.
            Text("Notification preferences and sound options").fixedSize()
            Toggle("Enabled", isOn: .constant(true))
        }
        .padding()
        .navigationTitle("Settings")
    }
}

struct DetailsView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 16) {
            Text("Details")
            Button(action: { dismiss() }) { Text("Close").frame(minWidth: 44, minHeight: 44) }
        }
    }
}
