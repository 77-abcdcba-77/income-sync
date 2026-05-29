import app


if __name__ == "__main__":
    app.init_db()
    app.app.run(host="127.0.0.1", port=5051, debug=False, use_reloader=False)
