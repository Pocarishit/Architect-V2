# Minimal PostgREST-style RPC shim over psql, for tests only (role anon, like the publishable key).
import json, subprocess, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
SIG = {
  'anytype_pair_finish': [('code','text'),('name','text')],
  'anytype_poll': [('token','text')],
  'anytype_destinations': [('token','text')],
  'anytype_list_mappings': [('token','text')],
  'anytype_save_mapping': [('token','text'),('m','jsonb')],
  'anytype_publish': [('token','text'),('p_mapping_id','uuid'),('p_mapping_version','int'),('items','jsonb'),('complete','boolean')],
  'anytype_report': [('token','text'),('p_mapping_id','uuid'),('p_mapping_version','int'),('p_status','text'),('p_message','text')],
}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        name = self.path.rsplit('/',1)[-1]
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)) or b'{}')
        if name not in SIG: return self.reply(404, {'message':'Could not find the function'})
        args = []
        for k, t in SIG[name]:
            if k not in body: continue
            v = body[k]
            if t == 'jsonb': expr = "(:'b'::jsonb)->'%s'" % k
            elif t == 'boolean': expr = "((:'b'::jsonb)->>'%s')::boolean" % k
            else: expr = "((:'b'::jsonb)->>'%s')::%s" % (k, t)
            args.append('%s => %s' % (k, expr))
        sql = "set role anon; select coalesce(to_jsonb(public.%s(%s)), 'null'::jsonb);" % (name, ', '.join(args))
        p = subprocess.run(['sudo','-u','postgres','psql','-d','axtest','-tAq','-v','ON_ERROR_STOP=1','-v','b='+json.dumps(body)], input=sql, capture_output=True, text=True)
        if p.returncode != 0:
            msg = p.stderr.split('ERROR:',1)[-1].strip().split('\n')[0]
            return self.reply(400, {'message': msg})
        out = p.stdout.strip().splitlines()
        return self.reply(200, json.loads(out[-1]) if out else None)
    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
