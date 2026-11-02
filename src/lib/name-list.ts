// Common given names and surnames (Swedish and Nordic, English, French, and more), spelled the way
// people write them. Matching uses an ASCII-folded key, so "helene" finds "Hélène".

const SWEDISH_NORDIC = `
Adam Agnes Albin Alex Alexander Alfred Alice Alicia Alma Alva Amanda Amelia Anders Andreas Anette Anita Ann Anna Anneli Annika Anton Arvid Astrid August Axel
Bengt Birgitta Björn Bo Britt Carin Carina Carl Caroline Cecilia Charlotte Christer Christina Clara Dag Dan Daniel David Ebba Edith Edvin Egil Einar Elias Elin Elina Elis Elisabeth Ella Ellen Ellinor Elliot Elsa Elsie Elvira Emil Emilia Emma Erik Erika Esther Eva Evelina
Fanny Felicia Filip Frans Fredrik Freja Frida Gerd Gun Gunilla Gunnar Gustav Göran Hampus Hanna Hannes Hans Harald Harriet Hedda Hedvig Helena Helene Henrik Hilda Hjalmar Hugo Hulda Ida Inga Inger Ingrid Isak Isabella Ivar
Jakob Jan Jenny Jesper Joakim Joel Johan Johanna Jonas Jonatan Josefin Josefine Julia Juni Jörgen Kajsa Karin Karl Kasper Katarina Kent Kerstin Kim Klara Kristian Kristina Kristoffer Lage Lars Leif Lena Leo Liam Lilly Linn Linnea Linus Lisa Lotta Love Lova Lovisa Ludvig Lukas Magnus Maja Malin Malte Marcus Margareta Maria Marie Markus Martin Matilda Mats Mattias Melker Melvin Mikael Milo Minna Moa Mona Märta
Nellie Nils Noa Noah Nora Olle Olof Oliver Olivia Oscar Otto Patrik Per Peter Petra Pontus Rasmus Ragnar Rebecka Rickard Rikard Robin Rut Saga Sam Sara Selma Sigrid Simon Sixten Siv Signe Sofia Sofie Stefan Stella Sten Stig Sune Svea Sven Teodor Therese Thea Tilda Tim Tindra Tobias Tomas Tora Tove Tuva Ulf Ulla Ulrika Valter Vera Viggo Viktor Viktoria Vilgot Vilma Ville Wilma William Ylva Åke Åsa Östen
Aino Aksel Anja Bjørn Freyja Gudrun Helmi Henna Ilmari Ingvild Jens Juha Jukka Kari Kirsten Lasse Leena Liisa Mads Mette Mikko Niklas Oskar Pekka Pernille Rune Sanna Sigurd Silje Sindre Solveig Søren Terje Tiina Torbjørn Tuomas Ville Väinö
`;

const ENGLISH = `
Aaron Abigail Adrian Aiden Alan Albert Alexandra Alfie Alison Amber Amy Andrew Angela Ann Anne Anthony Archie Arthur Ashley Austin Ava Barbara Becky Ben Benjamin Beth Bethany Betty Bill Bob Bobby Brad Brandon Brenda Brian Brooke Bruce
Caleb Callum Cameron Carol Caroline Carter Catherine Charlie Charles Charlotte Chelsea Chloe Chris Christian Christopher Claire Connor Courtney Craig Dan Danielle Darren Dave David Dean Deborah Dennis Diana Donna Dorothy Dylan
Edward Eleanor Elizabeth Ellie Emily Eric Ethan Evan Evie Finn Florence Frank Freddie Gareth Gary George Georgia Grace Graham Greg Gregory Hannah Harper Harriet Harry Harvey Hayden Heather Helen Henry Holly Ian Isaac Isabel Isla Ivy
Jack Jackson Jacob Jake James Jamie Jane Jasmine Jason Jayden Jeff Jennifer Jenny Jeremy Jess Jessica Jill Jim Joan Joe Joel John Jonathan Jordan Joseph Josh Joshua Joy Joyce Judith Julia Julie Justin Karen Kate Katherine Katie Kayla Keith Kelly Ken Kevin Kim Kimberly Kyle
Laura Lauren Leah Lee Lewis Liam Lily Linda Lisa Logan Louis Lucy Luke Madison Maisie Mandy Margaret Mark Martha Mary Mason Matt Matthew Megan Melissa Michael Michelle Mike Molly Morgan Nancy Natalie Nathan Neil Nicholas Nick Nicole Noah Oliver Olivia Oscar Owen
Pamela Patricia Patrick Paul Peter Philip Phoebe Poppy Rachel Rebecca Richard Riley Rob Robert Robyn Roger Ronald Rose Ruby Russell Ruth Ryan Sally Sam Samantha Samuel Sandra Sarah Scott Sean Sharon Shaun Sienna Simon Sophia Sophie Stacey Stephen Steve Steven Stuart Susan
Taylor Teresa Theo Thomas Tim Timothy Toby Tom Tommy Tony Tracy Tyler Vanessa Victoria Wayne Wendy William Willow Zachary Zoe
`;

const FRENCH = `
Adèle Adrien Agathe Aimé Alain Albane Alexandre Alexis Alice Aline Amandine Amélie Anaïs André Anne Antoine Apolline Ariane Arnaud Arthur Aurélie Aurélien Baptiste Bastien Béatrice Benoît Bernard Brigitte Camille Capucine Céline Chantal Charles Charlotte Chloé Christelle Christophe Claire Clara Claude Clément Clémence Colette Corentin Cyril
Damien Delphine Denis Didier Dominique Éléonore Élise Éloïse Émile Émilie Emma Enzo Éric Estelle Étienne Eugénie Fabien Fabrice Florence Florian François Françoise Frédéric Gabriel Gaëlle Gaspard Geneviève Georges Gérard Guillaume Gilles Hélène Henri Hugo Inès Isabelle Jacques Jean Jeanne Jérémy Jérôme Joséphine Jules Julie Julien Juliette Justine
Laetitia Laure Laurent Léa Léna Léo Léon Léonie Lou Louis Louise Luc Lucas Lucie Lucien Madeleine Maël Manon Marc Margaux Marguerite Marie Marine Martine Mathilde Mathieu Maxime Mélanie Michel Mireille Monique Nathalie Nicolas Noémie Océane Olivier Pascal Pauline Philippe Pierre
Quentin Raphaël Rémi Renée Romain Rose Sabine Sandrine Sébastien Simone Solène Sophie Stéphane Stéphanie Suzanne Sylvie Théo Thibault Thierry Thomas Timothée Valentin Valérie Vincent Virginie Yann Yves Zoé
`;

const WORLD = `
Aaliyah Abdul Ada Adnan Ahmed Aisha Ali Alessandro Alessia Alba Alejandro Alicja Amir Amira Ana Andrea Andrei Ángel Anja Anouk Antonio Arjun Bruno Carla Carlos Carmen Chen Chiara Cristina Dario Dmitri Diego Elena Elif Emir Enrique Fatima Federico Felipe Fernando Francesca Francesco
Giovanni Giulia Hamza Hana Hassan Hiroshi Ibrahim Igor Ines Irina Isabela Ivan Javier Jorge José Juan Kai Karim Katarzyna Kenji Khalid Lars Laila Layla Leila Lorenzo Luca Lucía Luis Luka Maja Marco Mariam Mario Marta Mateo Matteo Maximilian Mehmet Mia Miguel Milan Mohammed Muhammad Nadia Natalia Nikola Nina Noor Omar Pablo Paolo Pedro Priya Rahul Raúl Ravi Reza Ricardo Rosa Sakura Salma Samir Sanjay Santiago Sergio Sofía Stefan Tariq Valentina Wei Yara Yasmin Yusuf Zainab Zara
Lukas Jonas Leon Finn Paul Felix Ben Elias Moritz Tobias Hannah Lena Lea Leonie Johanna Katharina Anke Jürgen Klaus Uwe Wolfgang Sabine Ute Thijs Daan Sem Bram Fleur Sanne Lotte
`;

const SURNAMES = `
Andersson Johansson Karlsson Nilsson Eriksson Larsson Olsson Persson Svensson Gustafsson Pettersson Jonsson Jansson Hansson Bengtsson Jönsson Lindberg Jakobsson Magnusson Olofsson Lindström Lindqvist Lindgren Berg Axelsson Bergström Lundberg Lind Lundgren Lundqvist Mattsson Berglund Fredriksson Sandberg Henriksson Forsberg Sjöberg Wallin Engström Eklund Danielsson Lundin Håkansson Björk Bergman Gunnarsson Holm Wikström Samuelsson Isaksson Fransson Bergqvist Nyström Holmberg Arvidsson Löfgren Söderberg Nyberg Blomqvist Claesson Nordström Mårtensson Lundström Ali Mohammed Viklund Björklund Eliasson Pålsson Berggren Sandström Lund Nordin Ström Åberg Hermansson Ekström Falk Holmgren Dahlberg Hellström Hedlund Sundberg Sjögren Ek Blom Abrahamsson Martinsson Öberg Andreasson Strömberg Månsson Åkesson Hansen Jensen Nielsen Kristensen Virtanen Korhonen Nieminen
Smith Jones Taylor Brown Williams Wilson Johnson Davies Robinson Wright Thompson Evans Walker White Roberts Green Hall Wood Jackson Clarke Patel Khan Lewis James Phillips Mason Mitchell Rose Davis Rodriguez Cox Alexander Garden Campbell Johnston Moore Smyth Oneill Doherty Stewart Quinn Murphy Graham Mclaughlin Hamilton Murray Hughes Robertson Thomson Scott Macdonald Reid Clark Ross Young Watson Paterson Morrison Miller Anderson Martin Lee Harris Turner Baker Cooper King Hill Ward Morris Moore Carter Bell Parker Adams Collins Edwards Stevens Price Bennett Gray Russell Fisher Kelly Ellis Shaw Lloyd Webb Simpson Palmer Hunt Holmes Mills Owen Fox
Martin Bernard Thomas Petit Robert Richard Durand Dubois Moreau Laurent Simon Michel Lefebvre Leroy Roux David Bertrand Morel Fournier Girard Bonnet Dupont Lambert Fontaine Rousseau Vincent Muller Lefevre Faure Andre Mercier Blanc Guerin Boyer Garnier Chevalier Francois Legrand Gauthier Garcia Perrin Robin Clement Morin Nicolas Henry Roussel Mathieu Gautier Masson Marchand Duval Denis Dumont Marie Lemaire Noel Meyer Dufour Meunier Brun Blanchard Giraud Joly Riviere Lucas Brunet Gaillard Barbier Arnaud Martinez Gerard Roche Renard Schmitt Roy Leroux Colin Vidal Caron Picard Roger Fabre Aubert Lemoine Renaud Dumas Lacroix Olivier Philippe Bourgeois Pierre Benoit Rey Leclerc Payet Rolland Leclercq Guillaume Lecomte Lopez Jean Dupuy Guillot Hubert Berger Carpentier Sanchez Dupuis Moulin Louis Deschamps Huet Vasseur Perez Boucher Fleury Royer Klein Jacquet Adam Paris Poirier Marty Aubry Guyot Carre Charles Renault Charpentier Menard Maillard Baron Bertin Bailly Herve Schneider Fernandez Le Collet Leger Bouvier Julien Prevost Millet Perrot Daniel Cousin Germain Breton Besson Langlois Remy Pelletier Leveque Perrier Leblanc Barre Lebrun Marchal Weber Mallet Hamon Boulanger Jacob Monnier Michaud Rodriguez Guichard Gillet Etienne Grondin Poulain Tessier Chevallier Collin Chauvin Da Bouchet Gay Lemaitre Benard Marechal Humbert Reynaud Antoine Hoarau Perret Barthelemy Cordier Pichon Lejeune Gilbert Lamy Delaunay Pasquier Carlier Laporte
Müller Schmidt Schneider Fischer Weber Wagner Becker Hoffmann Schulz Koch Richter Rossi Russo Ferrari Esposito Bianchi Romano Colombo Ricci González Rodríguez Fernández López Martínez Sánchez Pérez Gómez Silva Santos Oliveira Souza Kowalski Nowak Wiśniewski Ivanov Petrov Novak Horvat Yilmaz Kaya Demir Nguyen Tran Wang Li Zhang Liu Chen Yang Huang Kim Park Choi Tanaka Suzuki Sato Singh Kumar Sharma Gupta Hussain Ahmed Hassan Ibrahim De Jong Jansen Visser Bakker
`;

const SURNAME_SUFFIXES = [
  "son",
  "sson",
  "berg",
  "ström",
  "strom",
  "qvist",
  "kvist",
  "quist",
  "gren",
  "lund",
  "holm",
  "dahl",
  "blad",
  "stedt",
  "sen",
  "nen",
  "ski",
  "ska",
  "ov",
  "ova",
  "ez",
  "ini",
  "elli",
  "mann",
  "man",
  "ley",
  "ton",
  "ford",
  "field",
  "wood",
  "eau",
  "ier",
  "ard",
  "oux",
  "ault",
  "ette",
];

export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .toLowerCase();

const toMap = (...lists: string[]) => {
  const m = new Map<string, string>();
  for (const list of lists)
    for (const n of list.split(/\s+/).filter(Boolean)) {
      const k = fold(n);
      // Prefer the accented spelling when the same key appears twice (e.g. Helene/Hélène keep the first).
      if (!m.has(k) || (m.get(k) === k[0].toUpperCase() + k.slice(1) && n !== m.get(k)))
        m.set(k, n);
    }
  return m;
};

export const GIVEN = toMap(SWEDISH_NORDIC, ENGLISH, FRENCH, WORLD);
export const FAMILY = toMap(SURNAMES);
export const GIVEN_COUNT = GIVEN.size;
export const FAMILY_COUNT = FAMILY.size;

export const looksLikeSurname = (t: string) =>
  FAMILY.has(t) || (t.length >= 4 && SURNAME_SUFFIXES.some((s) => t.endsWith(s)));
