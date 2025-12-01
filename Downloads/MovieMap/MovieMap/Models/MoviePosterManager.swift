//
//  MoviePosterManager.swift
//  MovieMap
//
//  Created by Abhiram Kancharla on 11/29/25.
//

import Foundation

struct TMDBSearchResponse: Codable {
    let results: [MoviePoster]
}

struct MoviePoster: Codable {
    let poster_path: String?
}

class MoviePosterManager {
    
    private var apiKey: String = "3a56c1626d9ee361dc8e95977bc09948"
    
    func fetchPosterURL(movieName: String) async throws -> String {
        let query = movieName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? movieName
        let url = "https://api.themoviedb.org/3/search/movie?api_key=\(apiKey)&query=\(query)"
        
        let (data, _) = try await URLSession.shared.data(from: URL(string: url)!)
        let result = try JSONDecoder().decode(TMDBSearchResponse.self, from: data)
        
        guard let poster = result.results.first?.poster_path else { return "" }
        
        return "https://image.tmdb.org/t/p/w500\(poster)"
    }
}
