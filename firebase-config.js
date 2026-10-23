// Firebase web config for project travel-planner-db061.
// These are public identifiers - access to data is enforced by the Firestore / Storage security rules.
export const firebaseConfig = {
  apiKey: "AIzaSyCVaKUxQBsoRW67g49Shr7ZOZLwZfACXQc",
  authDomain: "travel-planner-db061.firebaseapp.com",
  projectId: "travel-planner-db061",
  storageBucket: "travel-planner-db061.firebasestorage.app",
  messagingSenderId: "249048419680",
  appId: "1:249048419680:web:e9630ce485e54c15902205"
};
// Shared family login (password is set in the Firebase console, never stored here)
export const FAMILY_EMAIL = "family@travelplanner.app";
// Google accounts that can edit (must match the security rules)
export const EDITORS = ["cesar.gonzalez.cruz1@gmail.com", "deb777deb@gmail.com"];
// Trip shown by the app
export const TRIP_ID = "usmx-2026";
export const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/12.19.0";
// AI that reads booking PDFs (Firebase AI Logic, Agent Platform Gemini API). First model that works is used.
export const AI_MODELS = ["gemini-3.6-flash", "gemini-3-flash", "gemini-2.5-flash"];
export const AI_LOCATION = "global";
