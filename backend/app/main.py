from fastapi import FastAPI

app = FastAPI(title="LearnOS AI API")


@app.get("/health")
def health_check():
    return {"status": "healthy"}