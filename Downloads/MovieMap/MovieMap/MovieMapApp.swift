//
//  MovieMapApp.swift
//  MovieMap
//
//  Created by Abhiram Kancharla on 11/10/25.
//

import SwiftUI

@main
struct MovieMapApp: App {
    
    @ObservedObject var cinemaViewModel = CinemaViewModel(movie: "", cinemas: [])
    @ObservedObject var filmAndCinemasModel = FilmAndCinemasModel(cinemaViewModels: [])
    
    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(cinemaViewModel)
                .environmentObject(filmAndCinemasModel)
        }
    }
}
