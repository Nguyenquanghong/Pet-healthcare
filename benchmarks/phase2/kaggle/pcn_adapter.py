"""Small wire-contract adapter; phase-1 task weights, pacing and timing stay intact."""
import uuid


def collection(body):
    if isinstance(body, list):
        return body
    if isinstance(body, dict) and isinstance(body.get('items'), list):
        return body['items']
    return None


def request_headers(method, name):
    # Phase 2 requires a key. One intent, one attempt: no automatic retry/backoff.
    return {'Idempotency-Key': str(uuid.uuid4())} if name == 'POST appointment' and method == 'POST' else {}


def contract_error(method, name, body, pet_id):
    if method == 'GET' and not isinstance(body, (dict, list)):
        return 'Invalid JSON collection'
    if name == 'GET pets':
        rows = collection(body)
        if rows is None or not any(isinstance(row, dict) and row.get('id') == pet_id for row in rows):
            return 'Own pet missing from response'
    if name == 'POST appointment':
        appointment = body.get('appointment') if isinstance(body, dict) else None
        if not isinstance(appointment, dict) or appointment.get('petId') != pet_id:
            return 'Created appointment does not belong to the selected pet'
    return None
