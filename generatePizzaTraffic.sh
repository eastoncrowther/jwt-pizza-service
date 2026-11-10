#!/bin/bash
# Simulates JWT Pizza user traffic against a pizza service.
# Usage: ./generatePizzaTraffic.sh <host>
# Example: ./generatePizzaTraffic.sh http://localhost:3000
# Requires curl and jq, and a database populated with generatePizzaData.sh.

if [ -z "$1" ]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 http://localhost:3000"
  exit 1
fi
host=$1

# Kill all background simulations on Ctrl+C
cleanup() {
  echo "Terminating background processes..."
  kill $(jobs -p) 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Prints "true" if a login response contains a token
login() {
  local response
  response=$(curl -s -X PUT "$host/api/auth" -d "{\"email\":\"$1\", \"password\":\"$2\"}" -H 'Content-Type: application/json')
  echo "$response" | jq -r '.token'
}

# Request the menu every 3 seconds
while true; do
  result=$(curl -s -o /dev/null -w "%{http_code}" "$host/api/order/menu")
  echo "Requesting menu... $result"
  sleep 3
done &

# Invalid login every 25 seconds
while true; do
  result=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$host/api/auth" -d '{"email":"unknown@jwt.com", "password":"bad"}' -H 'Content-Type: application/json')
  echo "Logging in with invalid credentials... $result"
  sleep 25
done &

# Franchisee logs in, logs out two minutes later
while true; do
  token=$(login "f@jwt.com" "franchisee")
  echo "Login franchisee... $([ -n "$token" ] && [ "$token" != "null" ] && echo true || echo false)"
  sleep 110
  result=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$host/api/auth" -H "Authorization: Bearer $token")
  echo "Logging out franchisee... $result"
  sleep 10
done &

# Diner logs in, buys a pizza, waits 20 seconds, logs out
while true; do
  token=$(login "d@jwt.com" "diner")
  echo "Login diner... $([ -n "$token" ] && [ "$token" != "null" ] && echo true || echo false)"
  result=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$host/api/order" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $token" \
    -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}')
  echo "Bought a pizza... $result"
  sleep 20
  result=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$host/api/auth" -H "Authorization: Bearer $token")
  echo "Logging out diner... $result"
  sleep 30
done &

# Hungry diner orders too many pizzas (factory rejects >20) every 5 minutes
while true; do
  token=$(login "d@jwt.com" "diner")
  echo "Login hungry diner... $([ -n "$token" ] && [ "$token" != "null" ] && echo true || echo false)"

  items='{ "menuId": 1, "description": "Veggie", "price": 0.05 }'
  for (( i=0; i < 21; i++ )); do
    items+=', { "menuId": 1, "description": "Veggie", "price": 0.05 }'
  done

  result=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$host/api/order" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $token" \
    -d "{\"franchiseId\": 1, \"storeId\":1, \"items\":[$items]}")
  echo "Bought too many pizzas... $result"
  sleep 5
  curl -s -o /dev/null -X DELETE "$host/api/auth" -H "Authorization: Bearer $token"
  echo "Logging out hungry diner..."
  sleep 295
done &

wait
