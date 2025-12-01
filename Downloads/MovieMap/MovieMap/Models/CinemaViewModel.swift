//
//  CinemaObject.swift
//  MovieMap
//
//  Created by Abhiram Kancharla on 11/23/25.
//

import Foundation

class CinemaViewModel: ObservableObject, Identifiable { // remove identifiable if causing problems
    
    @Published var movie_name: String = ""
    @Published var cinemas: [Cinema] = []
    
    init(movie: String, cinemas: [Cinema]) {
        self.cinemas = cinemas
        self.movie_name = movie
    }
    
    func addCinema(cinema: Cinema) {
        cinemas.append(cinema)
    }
    
    func setMovie(_ movie: String) {
        self.movie_name = movie
        print("Set Movie Name!")
    }
}
