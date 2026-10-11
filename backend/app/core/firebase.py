from logging import getLogger

import firebase_admin
from fastapi import HTTPException
from firebase_admin import auth, firestore

from app.core.config import FIREBASE_PROJECT_ID

logger = getLogger(__name__)


def get_firebase_app():
    if not FIREBASE_PROJECT_ID:
        raise HTTPException(
            status_code=503,
            detail="Set FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT for Firebase Admin.",
        )
    try:
        return firebase_admin.get_app()
    except ValueError:
        options = {"projectId": FIREBASE_PROJECT_ID} if FIREBASE_PROJECT_ID else {}
        return firebase_admin.initialize_app(options=options)


def get_firestore_client():
    try:
        return firestore.client(get_firebase_app())
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Firestore is unavailable. Configure Firebase Admin credentials for this environment.",
        ) from exc


def verify_firebase_id_token(id_token: str) -> dict:
    try:
        return auth.verify_id_token(id_token, app=get_firebase_app())
    except (auth.InvalidIdTokenError, auth.ExpiredIdTokenError, auth.RevokedIdTokenError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired Firebase ID token.") from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Firebase token verification failed (%s).", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Firebase token verification is unavailable.") from exc