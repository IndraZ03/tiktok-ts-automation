import requests

# Ganti dengan data Green-API Anda
ID_INSTANCE = "7103957889"
API_TOKEN = "8eca423d65e444f3b9234c41252c4b8764533d7f18c643a8ad"

url = f"https://api.green-api.com/waInstance{ID_INSTANCE}/getChats/{API_TOKEN}"

try:
    response = requests.get(url, timeout=30)
    response.raise_for_status()

    chats = response.json()

    print("\n=== DAFTAR GRUP WHATSAPP ===\n")

    found = False
    for chat in chats:
        chat_id = chat.get("id", "")

        # Grup WhatsApp selalu berakhiran @g.us
        if chat_id.endswith("@g.us"):
            found = True
            print(f"Nama Grup : {chat.get('name', 'Tidak diketahui')}")
            print(f"Group ID  : {chat_id}")
            print("-" * 50)

    if not found:
        print("Tidak ada grup yang ditemukan.")
        print("Pastikan nomor WhatsApp sudah bergabung ke grup.")

except requests.exceptions.RequestException as e:
    print(f"Error: {e}")