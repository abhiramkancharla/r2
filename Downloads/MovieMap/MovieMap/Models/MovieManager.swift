//
//  MovieManager.swift
//  MovieMap
//
//  Created by Abhiram Kancharla on 11/10/25.
//

import Foundation

struct FilmResponse: Codable {
    var films: [Film]
}

struct Film: Codable {
    var film_id: Int
    var imdb_id: Int
    var film_name: String
    var synopsis_long: String
}

struct Cinema: Codable {
    var cinema_id: Int
    var cinema_name: String
    var address: String
    var city: String
    var state: String
    var lat: Float
    var lng: Float
    var logo_url: String
    var date: String
    var time: String
}

struct closestFilmResponse: Codable {
    var film_id: Int
    var imdb_id: Int
    var imdb_title_id: String
    var film_name: String
    var other_titles: String?
    var cinemas: [Cinema]
}

class MovieManager {
    
    private var client = "MOV_0"
    private var apiKey = "0Issm6Pa2F7uykFDmeu51gxQAfRQVXj7R9TZYGXa"
    private var authorization = "Basic TU9WXzA6ZUhsQVMyYU5YaTNO"
    private var territory = "US" // e.g. "US"
    private var apiVersion = "v201"
    
    func fetchCurrentlyShowingFilms() async throws -> [Film] {
        let deviceDatetime = ISO8601DateFormatter().string(from: Date())
        
        let url = URL(string: "https://api-gate2.movieglu.com/filmsNowShowing/?n=3")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        
        request.addValue(client, forHTTPHeaderField: "client")
        request.addValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.addValue(authorization, forHTTPHeaderField: "authorization")
        request.addValue(territory, forHTTPHeaderField: "territory")
        request.addValue(apiVersion, forHTTPHeaderField: "api-version")
        request.addValue(deviceDatetime, forHTTPHeaderField: "device-datetime")
        request.addValue("application/json", forHTTPHeaderField: "Accept")
        
        
        let (data, _) = try await URLSession.shared.data(for: request)
        
        let decoded = try JSONDecoder().decode(FilmResponse.self, from: data)
        
        return decoded.films
    }
    
    func fetchClosestShowing(film_id: Int) async throws -> closestFilmResponse {
        let deviceDatetime = ISO8601DateFormatter().string(from: Date())
        let url = URL(string: "https://api-gate2.movieglu.com/closestShowing/?n=3&film_id=\(film_id)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        
        let latitude = 35.91
        let longitude = -79.06
        
        request.addValue(client, forHTTPHeaderField: "client")
        request.addValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.addValue(authorization, forHTTPHeaderField: "authorization")
        request.addValue(territory, forHTTPHeaderField: "territory")
        request.addValue(apiVersion, forHTTPHeaderField: "api-version")
        request.addValue(deviceDatetime, forHTTPHeaderField: "device-datetime")
        request.addValue("application/json", forHTTPHeaderField: "Accept")
        
        let geolocationHeader = "\(latitude);\(longitude)"
        request.addValue(geolocationHeader, forHTTPHeaderField: "geolocation")
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        if let httpResponse = response as? HTTPURLResponse {
            print("Status code:", httpResponse.statusCode)
        }

        if let raw = String(data: data, encoding: .utf8) {
            print("Raw response body:\n\(raw)")
        } else {
            print("⚠️ Could not decode response body as UTF-8 string")
        }
        let decoded = try JSONDecoder().decode(closestFilmResponse.self, from: data)
        
        return decoded
    }
}
