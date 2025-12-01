//
//  ContentView.swift
//  MovieMap
//
//  Created by Abhiram Kancharla on 11/10/25.
//

import SwiftUI


struct ContentView: View {
    
    @State private var films: [Film] = []
    @State private var showMap: Bool = true
    
    @EnvironmentObject var cinemaViewModel: CinemaViewModel
    @EnvironmentObject var filmAndCinemasModel: FilmAndCinemasModel
        
    @State var cinemaViewModels: [CinemaViewModel] = []
    
    let movieManager = MovieManager()
    
    var body: some View {
        VStack {
            MapView()
                .environmentObject(cinemaViewModel)
                .environmentObject(filmAndCinemasModel)
                .frame(width: UIScreen.main.bounds.width, height: UIScreen.main.bounds.height)
                .ignoresSafeArea()
        }
        .onAppear {
            Task { await getClosestTheaterAndMovie() }
        }
        .padding()
    }
    
    func showMovies() async {
        do {
            let films = try await movieManager.fetchCurrentlyShowingFilms()
            print("Got films")
            
            for film in films {
                print(film.film_id)
                print(film.film_name)
            }
        } catch {
            print("Error!", error)
        }
    }
    
    func getClosestTheaterAndMovie() async {
        do {
            let films = try await movieManager.fetchCurrentlyShowingFilms()
            
            for film in films {
                
                let theatersWithFilm = try await movieManager.fetchClosestShowing(film_id: film.film_id)
                
                let newCinemaViewModel = CinemaViewModel(movie: film.film_name, cinemas: [])
                print(film.film_name)
                newCinemaViewModel.setMovie(film.film_name)
                
                for cinema in theatersWithFilm.cinemas {
                    
                    let estCinema = convertCinemaTimes(cinema)
                    
                    print("\(film.film_name) is available to watch in \(estCinema.cinema_name) at \(estCinema.time)")
                    newCinemaViewModel.addCinema(cinema: estCinema)
                }
                
                filmAndCinemasModel.addCinemaModel(cinemaModel: newCinemaViewModel)
            }
        } catch {
            print("Error!", error)
        }
    }
    
    private func convertCinemaTimes(_ cinema: Cinema) -> Cinema {
        let EST_time = convertUTCtoEST(cinema.time)
        let newCinema = Cinema(cinema_id: cinema.cinema_id, cinema_name: cinema.cinema_name, address: cinema.address, city: cinema.city, state: cinema.state, lat: cinema.lat, lng: cinema.lng, logo_url: cinema.logo_url, date: cinema.date, time: EST_time)
        return newCinema
    }
    
    private func convertUTCtoEST(_ time: String) -> String {
        let parts = time.split(separator: ":")
        guard parts.count == 2,
              let hour = Int(parts[0]),
              let minute = Int(parts[1]) else {
            return time
        }

        let estHour = (hour - 5 + 24) % 24

        return String(format: "%02d:%02d", estHour, minute)
    }

}

#Preview {
    ContentView()
        .environmentObject(CinemaViewModel(movie: "", cinemas: []))
        .environmentObject(FilmAndCinemasModel(cinemaViewModels: []))
}
