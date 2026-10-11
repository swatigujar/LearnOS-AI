import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "./firebase";

export async function ensureUserProfile(user: User, displayName?: string) {
  const profileRef = doc(db, "users", user.uid);
  const profile = await getDoc(profileRef);
  const profileName = displayName?.trim() || user.displayName || null;

  await setDoc(
    profileRef,
    {
      uid: user.uid,
      email: user.email,
      displayName: profileName,
      ...(profile.exists() ? {} : { createdAt: serverTimestamp() }),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  return profile;
}