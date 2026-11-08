"""Validate the supported, self-contained GLB upload format before storing it."""
import json
import struct

MAX_MODEL_BYTES = 20 * 1024 * 1024


def validate_glb(raw):
    try:
        magic, version, length = struct.unpack_from('<4sII', raw)
        if magic != b'glTF' or version != 2 or length != len(raw):
            raise ValueError()
        chunks = []
        offset = 12
        while offset < length:
            size, kind = struct.unpack_from('<II', raw, offset)
            offset += 8
            if size % 4 or offset + size > length:
                raise ValueError()
            chunks.append((kind, raw[offset:offset + size]))
            offset += size
        if len(chunks) != 2 or chunks[0][0] != 0x4E4F534A or chunks[1][0] != 0x004E4942:
            raise ValueError()
        doc = json.loads(chunks[0][1])
        if doc['asset']['version'] != '2.0':
            raise ValueError()
        # Only embedded binary resources are accepted, including optional extensions.
        def check_resources(value):
            if isinstance(value, dict):
                if 'uri' in value:
                    raise ValueError()
                for item in value.values():
                    check_resources(item)
            elif isinstance(value, list):
                for item in value:
                    check_resources(item)
        check_resources(doc)
        if set(doc.get('extensionsRequired', [])) - {'KHR_materials_unlit'}:
            raise ValueError()
        buffers = doc['buffers']
        if len(buffers) != 1 or not 0 < buffers[0]['byteLength'] <= len(chunks[1][1]):
            raise ValueError()
        for view in doc['bufferViews']:
            start = view.get('byteOffset', 0)
            if view['buffer'] != 0 or start < 0 or view['byteLength'] <= 0:
                raise ValueError()
            if start + view['byteLength'] > buffers[0]['byteLength']:
                raise ValueError()
        accessors = doc['accessors']
        if sum(a['count'] for a in accessors) > 6_000_000:
            raise ValueError()
        for accessor in accessors:
            if accessor['count'] <= 0 or accessor.get('sparse'):
                raise ValueError()
            index = accessor['bufferView']
            if not isinstance(index, int) or not 0 <= index < len(doc['bufferViews']):
                raise ValueError()
            components = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT2': 4, 'MAT3': 9, 'MAT4': 16}
            widths = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
            element = components[accessor['type']] * widths[accessor['componentType']]
            view = doc['bufferViews'][index]
            stride = view.get('byteStride', element)
            start = accessor.get('byteOffset', 0)
            if start < 0 or stride < element or start + stride * (accessor['count'] - 1) + element > view['byteLength']:
                raise ValueError()
        if not doc['meshes'] or not doc['scenes'][doc.get('scene', 0)]['nodes']:
            raise ValueError()
        for mesh in doc['meshes']:
            if not mesh['primitives']:
                raise ValueError()
            for primitive in mesh['primitives']:
                index = primitive['attributes']['POSITION']
                if not isinstance(index, int) or not 0 <= index < len(accessors):
                    raise ValueError()
                if accessors[index]['type'] != 'VEC3':
                    raise ValueError()
        # glTF nodes form trees. Reject cycles and repeated children before loading.
        visited = set()
        def visit(index):
            if not isinstance(index, int) or not 0 <= index < len(doc['nodes']) or index in visited:
                raise ValueError()
            visited.add(index)
            for child in doc['nodes'][index].get('children', []):
                visit(child)
        for index in doc['scenes'][doc.get('scene', 0)]['nodes']:
            visit(index)
    except (ValueError, KeyError, IndexError, TypeError, AttributeError, struct.error, RecursionError, UnicodeError):
        raise ValueError('텍스처를 포함한 비압축 GLB 2.0 파일이 필요합니다. 외부 파일 참조와 압축 확장은 지원하지 않습니다.') from None
