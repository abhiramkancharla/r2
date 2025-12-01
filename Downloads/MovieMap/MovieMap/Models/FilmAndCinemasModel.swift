//
//  FilmAndCinemas.swift
//  MovieMap
//
//  Created by Abhiram Kancharla on 11/30/25.
//

import Foundation

class FilmAndCinemasModel: ObservableObject {
    
    @Published var cinemaViewModels: [CinemaViewModel] = []
    
    init(cinemaViewModels: [CinemaViewModel]) {
        self.cinemaViewModels = cinemaViewModels
    }
    
    func addCinemaModel(cinemaModel: CinemaViewModel) {
        cinemaViewModels.append(cinemaModel)
        print("Added \(cinemaModel.movie_name)")
    }
}
