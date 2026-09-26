/**
 * Large metropolitan areas as [lon, lat, population in millions], rounded.
 * Only the fallback night lights use them (when the NASA night imagery is not
 * available): each becomes a glow sized by its population, with a scatter of
 * satellite towns around it.
 */
export const MAP_METROS: ReadonlyArray<readonly [number, number, number]> = [
  // East Asia
  [139.69, 35.68, 37], // Tokyo
  [135.5, 34.69, 19], // Osaka
  [136.91, 35.18, 9], // Nagoya
  [130.4, 33.59, 5.5], // Fukuoka
  [141.35, 43.06, 2.6], // Sapporo
  [126.98, 37.57, 25], // Seoul
  [129.08, 35.18, 3.4], // Busan
  [125.75, 39.02, 3], // Pyongyang
  [116.41, 39.9, 21], // Beijing
  [117.2, 39.08, 14], // Tianjin
  [121.47, 31.23, 27], // Shanghai
  [118.8, 32.06, 9], // Nanjing
  [120.16, 30.27, 12], // Hangzhou
  [114.31, 30.59, 11], // Wuhan
  [113.26, 23.13, 19], // Guangzhou
  [114.06, 22.54, 13], // Shenzhen
  [114.17, 22.32, 7.5], // Hong Kong
  [106.55, 29.56, 16], // Chongqing
  [104.07, 30.57, 16], // Chengdu
  [108.94, 34.34, 12], // Xi'an
  [123.43, 41.8, 8], // Shenyang
  [126.63, 45.75, 6], // Harbin
  [113.62, 34.75, 10], // Zhengzhou
  [120.38, 36.07, 7], // Qingdao
  [117.0, 36.65, 7], // Jinan
  [102.83, 24.88, 6], // Kunming
  [121.56, 25.03, 7], // Taipei
  // South-East Asia
  [120.98, 14.6, 14], // Manila
  [106.63, 10.82, 9], // Ho Chi Minh City
  [105.85, 21.03, 8], // Hanoi
  [100.5, 13.76, 11], // Bangkok
  [101.69, 3.14, 8], // Kuala Lumpur
  [103.82, 1.35, 6], // Singapore
  [106.85, -6.21, 34], // Jakarta
  [112.75, -7.25, 7], // Surabaya
  [107.61, -6.92, 8], // Bandung
  [96.2, 16.87, 5.5], // Yangon
  // South Asia
  [90.41, 23.81, 22], // Dhaka
  [88.36, 22.57, 15], // Kolkata
  [77.21, 28.61, 31], // Delhi
  [72.88, 19.08, 21], // Mumbai
  [77.59, 12.97, 13], // Bangalore
  [80.27, 13.08, 11], // Chennai
  [78.49, 17.39, 10], // Hyderabad
  [72.57, 23.02, 8], // Ahmedabad
  [73.86, 18.52, 7], // Pune
  [80.95, 26.85, 4], // Lucknow
  [67.01, 24.86, 16], // Karachi
  [74.34, 31.55, 13], // Lahore
  [69.21, 34.56, 4.5], // Kabul
  // Middle East, Central Asia, Russia
  [51.39, 35.69, 9], // Tehran
  [59.6, 36.3, 3.3], // Mashhad
  [44.36, 33.31, 7], // Baghdad
  [46.68, 24.71, 7.5], // Riyadh
  [39.19, 21.49, 4.5], // Jeddah
  [55.27, 25.2, 5], // Dubai
  [51.53, 25.29, 2.4], // Doha
  [47.98, 29.38, 3], // Kuwait City
  [34.78, 32.09, 4], // Tel Aviv
  [28.98, 41.01, 15.5], // Istanbul
  [32.86, 39.93, 5.5], // Ankara
  [76.89, 43.24, 2], // Almaty
  [69.24, 41.3, 2.5], // Tashkent
  [82.92, 55.03, 1.6], // Novosibirsk
  [60.6, 56.84, 1.5], // Yekaterinburg
  [37.62, 55.76, 17], // Moscow
  [30.32, 59.94, 5.5], // Saint Petersburg
  // Europe
  [-0.13, 51.51, 14], // London
  [2.35, 48.86, 11], // Paris
  [-3.7, 40.42, 6.7], // Madrid
  [2.17, 41.39, 5.5], // Barcelona
  [-9.14, 38.72, 2.9], // Lisbon
  [12.5, 41.9, 4.3], // Rome
  [9.19, 45.46, 4.9], // Milan
  [14.27, 40.85, 3], // Naples
  [13.4, 52.52, 4.5], // Berlin
  [9.99, 53.55, 2.5], // Hamburg
  [11.58, 48.14, 2.9], // Munich
  [7.01, 51.46, 6], // Rhine-Ruhr
  [8.68, 50.11, 2.7], // Frankfurt
  [4.9, 52.37, 3], // Amsterdam
  [4.35, 50.85, 2.5], // Brussels
  [16.37, 48.21, 2.9], // Vienna
  [21.01, 52.23, 3.1], // Warsaw
  [14.42, 50.08, 2.2], // Prague
  [19.04, 47.5, 3], // Budapest
  [26.1, 44.43, 2.2], // Bucharest
  [23.73, 37.98, 3.6], // Athens
  [30.52, 50.45, 3.5], // Kyiv
  [27.56, 53.9, 2], // Minsk
  [18.07, 59.33, 2.4], // Stockholm
  [12.57, 55.68, 2], // Copenhagen
  [10.75, 59.91, 1.5], // Oslo
  [24.94, 60.17, 1.5], // Helsinki
  [-2.24, 53.48, 2.8], // Manchester
  [-1.89, 52.49, 2.9], // Birmingham
  [-6.26, 53.35, 1.9], // Dublin
  [4.84, 45.76, 2.3], // Lyon
  // Africa
  [31.24, 30.04, 21], // Cairo
  [29.92, 31.2, 5.5], // Alexandria
  [3.38, 6.52, 15], // Lagos
  [15.27, -4.44, 15], // Kinshasa
  [13.23, -8.84, 9], // Luanda
  [28.05, -26.2, 10], // Johannesburg
  [18.42, -33.92, 4.7], // Cape Town
  [31.03, -29.86, 3.5], // Durban
  [36.82, -1.29, 5], // Nairobi
  [38.76, 9.03, 5], // Addis Ababa
  [39.28, -6.79, 7], // Dar es Salaam
  [32.53, 15.5, 6], // Khartoum
  [-7.59, 33.57, 4], // Casablanca
  [3.06, 36.75, 3], // Algiers
  [10.18, 36.81, 2.5], // Tunis
  [-0.19, 5.6, 2.6], // Accra
  [-4.01, 5.36, 5.5], // Abidjan
  [-17.47, 14.72, 3.3], // Dakar
  [8.52, 12.0, 4], // Kano
  // North America
  [-74.01, 40.71, 20], // New York
  [-118.24, 34.05, 13], // Los Angeles
  [-87.63, 41.88, 9.5], // Chicago
  [-96.8, 32.78, 7.6], // Dallas
  [-95.37, 29.76, 7.1], // Houston
  [-77.04, 38.91, 6.3], // Washington
  [-75.17, 39.95, 6.2], // Philadelphia
  [-80.19, 25.76, 6.1], // Miami
  [-84.39, 33.75, 6.1], // Atlanta
  [-71.06, 42.36, 4.9], // Boston
  [-112.07, 33.45, 4.9], // Phoenix
  [-122.42, 37.77, 7.7], // San Francisco Bay Area
  [-122.33, 47.61, 4], // Seattle
  [-83.05, 42.33, 4.3], // Detroit
  [-93.27, 44.98, 3.7], // Minneapolis
  [-117.16, 32.72, 3.3], // San Diego
  [-104.99, 39.74, 3], // Denver
  [-90.2, 38.63, 2.8], // St. Louis
  [-115.14, 36.17, 2.3], // Las Vegas
  [-81.38, 28.54, 2.7], // Orlando
  [-79.38, 43.65, 6.4], // Toronto
  [-73.57, 45.5, 4.3], // Montreal
  [-123.12, 49.28, 2.6], // Vancouver
  [-114.07, 51.05, 1.5], // Calgary
  [-99.13, 19.43, 22], // Mexico City
  [-103.35, 20.66, 5.3], // Guadalajara
  [-100.32, 25.69, 5.3], // Monterrey
  [-82.37, 23.11, 2.1], // Havana
  [-69.93, 18.49, 3.5], // Santo Domingo
  [-90.51, 14.63, 3], // Guatemala City
  // South America
  [-74.07, 4.71, 11], // Bogota
  [-75.56, 6.25, 4], // Medellin
  [-66.9, 10.48, 3], // Caracas
  [-78.47, -0.18, 2], // Quito
  [-77.04, -12.05, 11], // Lima
  [-70.67, -33.45, 7], // Santiago
  [-58.38, -34.6, 15.5], // Buenos Aires
  [-46.63, -23.55, 22], // Sao Paulo
  [-43.17, -22.91, 13.5], // Rio de Janeiro
  [-43.94, -19.92, 6], // Belo Horizonte
  [-47.88, -15.79, 4.8], // Brasilia
  [-38.5, -12.97, 4], // Salvador
  [-34.88, -8.05, 4], // Recife
  [-38.54, -3.72, 4], // Fortaleza
  [-51.23, -30.03, 4.3], // Porto Alegre
  // Oceania
  [151.21, -33.87, 5.3], // Sydney
  [144.96, -37.81, 5.1], // Melbourne
  [153.03, -27.47, 2.5], // Brisbane
  [115.86, -31.95, 2.1], // Perth
  [138.6, -34.93, 1.4], // Adelaide
  [174.76, -36.85, 1.7], // Auckland
];
