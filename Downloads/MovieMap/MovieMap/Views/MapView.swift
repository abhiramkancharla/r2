//
//  MapView.swift
//  MovieMap
//
//  Created by Abhiram Kancharla on 11/23/25.
//

import CoreLocation
import SwiftUI
import MapKit

struct MapView: View {
    
    let moviePosterManager = MoviePosterManager()
    
    @EnvironmentObject var cinemaViewModel: CinemaViewModel
    @EnvironmentObject var filmAndCinemasModel: FilmAndCinemasModel
    
    @State private var position = MapCameraPosition.automatic
    @State private var mapType: MapStyle = .standard
    @State private var hasCenteredOnUser = false
    @State private var showMovieDetails = false // default: false
    
    @State private var region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 35.91, longitude: -79.06),
        span: MKCoordinateSpan(latitudeDelta: 0.05, longitudeDelta: 0.05))
    
    @State private var regions: [MKCoordinateRegion] = []
    @State private var movieNames: [String] = []
    @State private var movieImages: [String: URL] = [:]
    @State private var existingCinemas: [String] = []
    
    @State private var selectedCinemaViewModel: CinemaViewModel? = nil

    @State private var locationManager = LocationManager()
    
    var body: some View {
        Map(position: $position) {

            ForEach(filmAndCinemasModel.cinemaViewModels.indices, id: \.self) { index in
                let cinemaVM = filmAndCinemasModel.cinemaViewModels[index]
                
                ForEach(cinemaVM.cinemas, id: \.cinema_id) { cinema in
                    
                    let coord = CLLocationCoordinate2D(latitude: CLLocationDegrees(cinema.lat), longitude: CLLocationDegrees(cinema.lng))
                    Annotation(cinemaVM.movie_name, coordinate: coord) {
                        PosterAnnotationView(cnvm: cinemaVM, url: movieImages[cinemaVM.movie_name]) {
//                            showMovieDetails.toggle()
                            selectedCinemaViewModel = cinemaVM
                        }
                    }
                }
            }
        }
        .onChange(of: filmAndCinemasModel.cinemaViewModels.count) {
            Task { await loadImages() }
            
            if filmAndCinemasModel.cinemaViewModels.count >= 3 {
                restrictCinemaToOneFilm()
            }
        }
        .mapStyle(mapType)
        .onAppear {
            position = MapCameraPosition.region(region)
            locationManager.requestAuthorization()

            //fillRegions()
            restrictCinemaToOneFilm()
            Task { await loadImages() }
        }
        .onReceive(locationManager.$lastLocation.compactMap { $0 }) { location in
            
            guard !hasCenteredOnUser else { return }
            let coord = location.coordinate
            let updatedRegion = MKCoordinateRegion(
                center: coord,
                span: MKCoordinateSpan(latitudeDelta: 0.02, longitudeDelta: 0.02)
            )
            region = updatedRegion
            position = .region(updatedRegion)
            
            hasCenteredOnUser = true
        }
        .sheet(item: $selectedCinemaViewModel) { cinemaVM in
            DetailedCinemaView(cinemaVM: cinemaVM)
                .presentationDetents([.medium, .large])
        }
    }
    
    struct URLImage: View {
        let url: URL
        var width: CGFloat = 60
        var height: CGFloat = 60
        @State private var uiImage: UIImage?

        var body: some View {
            Group {
                if let uiImage = uiImage {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: width, height: height)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                } else {
                    ProgressView()
                        .onAppear { load() }
                }
            }
        }

        func load() {
            Task {
                do {
                    let (data, _) = try await URLSession.shared.data(from: url)
                    if let img = UIImage(data: data) {
                        uiImage = img
                    }
                } catch {
                    print("Image load failed:", error)
                }
            }
        }
    }
    
    struct PosterAnnotationView: View {
        let cnvm: CinemaViewModel
        let url: URL?
        let onTap: () -> Void
        
        var body: some View {
            ZStack {
                if let url {
                    Button {
                        onTap()
                    } label: {
                        URLImage(url: url, width: 60, height: 60)
                    }
                } else {
                    ProgressView()
                }
            }
            .frame(width: 60, height: 60)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
    
    struct DetailedCinemaView: View {
        let cinemaVM: CinemaViewModel
            
        var body: some View {
            ZStack {
                VStack {
                    HStack {
                        Text(cinemaVM.movie_name) // movie_name
                            .font(.title)
                            .foregroundStyle(.white.opacity(0.7))
                            .padding([.leading], 40)
                            .padding([.top], 60)
                        Spacer()
                    }
                    HStack {
                        Text(cinemaVM.cinemas[0].cinema_name) // cinemas[0].cinema_name
                            .font(.headline)
                            .padding([.leading], 40)
                        Text(cinemaVM.cinemas[0].address) // cinemas[0].address
                            .font(.caption)
                            .padding()
                        Spacer()
                    }
                    .padding([.top], -10)
                    TimerDisplay(time: cinemaVM.cinemas[0].time) // cinemas[0].time
                    Spacer()
                }
            }
        }
    }
    
    struct TimerDisplay: View {
        let time: String
        
        var parts: [Substring] {
            time.split(separator: ":")
        }
        
        var body: some View {
            ZStack {
                HStack {
                    ZStack {
                        
                        if #available(iOS 26.0, *) {
                            RoundedRectangle(cornerRadius: 3)
                                .frame(width: 175, height: 300)
                                .cornerRadius(50, corners: [.topLeft, .bottomLeft])
                                .foregroundStyle(.ultraThickMaterial)
                                .glassEffect(.regular.tint(.black.opacity(0.25)))
                        } else {
                            RoundedRectangle(cornerRadius: 3)
                                .frame(width: 175, height: 300)
                                .cornerRadius(50, corners: [.topLeft, .bottomLeft])
                                .foregroundStyle(.ultraThickMaterial)
                        }
                        Text(parts[0])
                            .font(.system(size: 100))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    ZStack {
                        if #available(iOS 26.0, *) {
                            RoundedRectangle(cornerRadius: 3)
                                .frame(width: 175, height: 300)
                                .cornerRadius(50, corners: [.topRight, .bottomRight])
                                .foregroundStyle(.thickMaterial)
                                .glassEffect(.regular.tint(.yellow.opacity(0.25)))
                        } else {
                            RoundedRectangle(cornerRadius: 3)
                                .frame(width: 175, height: 300)
                                .cornerRadius(50, corners: [.topRight, .bottomRight])
                                .foregroundStyle(.thickMaterial)
                        }
                        Text(parts[1])
                            .font(.system(size: 100))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                }
            }
        }
    }
    
    func restrictCinemaToOneFilm() {
        for cinemaVMIndex in filmAndCinemasModel.cinemaViewModels.indices {
            let cinemaVM = filmAndCinemasModel.cinemaViewModels[cinemaVMIndex]

            // Find the first cinema that hasn't been used yet
            if let firstNewCinema = cinemaVM.cinemas.first(where: { !existingCinemas.contains($0.cinema_name) }) {
                existingCinemas.append(firstNewCinema.cinema_name)
                filmAndCinemasModel.cinemaViewModels[cinemaVMIndex].cinemas = [firstNewCinema]
                print("\(firstNewCinema.cinema_name) is used!")
            } else {
                // If all cinemas were already used, remove all
                filmAndCinemasModel.cinemaViewModels[cinemaVMIndex].cinemas = []
            }
        }
    }
    
    @MainActor
    func loadImages() async {
        for cinemaVM in filmAndCinemasModel.cinemaViewModels {
            if let urlString = try? await moviePosterManager.fetchPosterURL(movieName: cinemaVM.movie_name),
               let url = URL(string: urlString) {
                movieImages[cinemaVM.movie_name] = url
            }
        }
    }
}

#Preview {
    MapView()
        .environmentObject(CinemaViewModel(movie: "", cinemas: []))
        .environmentObject(FilmAndCinemasModel(cinemaViewModels: []))
}


//        MKCoordinateRegion(
//            center: CLLocationCoordinate2D(latitude: 35.7812, longitude: -78.758202),
//            span: MKCoordinateSpan(latitudeDelta: 0.05, longitudeDelta: 0.05)
//        )

