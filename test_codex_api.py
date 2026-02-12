import requests
import json
import uuid
import os
import sys

def test_codex_api():
    # Configuration
    base_url = "http://127.0.0.1:3000/openai/responses"
    
    # Try to get API key from environment variable first
    api_key = os.environ.get("CRS_API_KEY")
    if not api_key:
        print("Please enter your Claude Relay Service API Key (starts with cr_):")
        api_key = input().strip()
    
    if not api_key:
        print("Error: API Key is required.")
        return

    # Headers required to pass CodexCliValidator
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "codex_cli_rs/0.38.0 (Test Script)",
        "originator": "codex_cli_rs",
        "session_id": str(uuid.uuid4()),
    }

    # Body with required instructions prefix
    payload = {
        "model": "gpt-5-codex",
        "messages": [
            {
                "role": "user",
                "content": "Hello, Codex! Please calculate 1 + 1 and tell me a joke about coding."
            }
        ],
        "instructions": "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\n\nThis is a test script.",
        "stream": False
    }

    print(f"\nSending request to {base_url}...")
    print(f"Session ID: {headers['session_id']}")
    
    try:
        response = requests.post(base_url, headers=headers, json=payload, timeout=30)
        
        print(f"\nResponse Status Code: {response.status_code}")
        
        if response.status_code == 200:
            print("\nResponse Body:")
            try:
                data = response.json()
                print(json.dumps(data, indent=2))
                
                # Try to extract the message content
                if 'choices' in data and len(data['choices']) > 0:
                    content = data['choices'][0].get('message', {}).get('content')
                    if content:
                        print("\n--- Extracted Content ---")
                        print(content)
                        print("-------------------------")
            except json.JSONDecodeError:
                print(response.text)
        else:
            print("\nError Response:")
            print(response.text)
            
    except Exception as e:
        print(f"\nAn error occurred: {e}")

if __name__ == "__main__":
    test_codex_api()
