//
//  HomeView.swift
//  MovieMap
//
//  Created by Abhiram Kancharla on 12/1/25.
//

import SwiftUI

struct HomeView: View {
    
    @EnvironmentObject var cinemaViewModel: CinemaViewModel
    @EnvironmentObject var filmAndCinemasModel: FilmAndCinemasModel
    
    var body: some View {
        NavigationView {
            VStack {
                ZStack {
                    PosterWall()
                        .overlay(
                            Color.black.opacity(0.6)
                        )
                        .blur(radius: 0.5)
                        .ignoresSafeArea()
                        .frame(width: UIScreen.main.bounds.width, height: UIScreen.main.bounds.height)
                    NavigationLink {
                        ContentView()
                    } label: {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(.yellow)
                            Text("Search")
                                .foregroundStyle(.black)
                        }
                    }
                    .frame(width: 300, height: 60)
                    .offset(y: 300)

                }
            }
            .navigationTitle("Movie Arrow")
        }
    }
    
    struct URLImage: View {
        let url: URL
        var width: CGFloat = 110
        var height: CGFloat = 140
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
    
    struct PosterWall: View {
        
        @State var movieWall = MovieWall()
        
        let columns = [
            GridItem(.flexible(), spacing: 30),
            GridItem(.flexible(), spacing: 30),
            GridItem(.flexible(), spacing: 30),

        ]
        
        var body: some View {
            LazyVGrid(columns: columns, spacing: 30) {
                ForEach(movieWall.icons, id: \.self) { icon in
                    URLImage(url: URL(string: icon)!)
                }
            }
        }
    }
}

#Preview {
    HomeView()
        .environmentObject(CinemaViewModel(movie: "", cinemas: []))
        .environmentObject(FilmAndCinemasModel(cinemaViewModels: []))
}
