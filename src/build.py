t=open('template.html').read(); b=open('bundle.js').read().replace('</script','<\\/script')
pk=open('/mnt/user-data/uploads/Developer/fengyuan-3d/data/fengyuan-osm-pack.b64.txt').read().strip()
open('fengyuan-3d.html','w').write(t.replace('/*__PACK__*/',pk).replace('/*__BUNDLE__*/',b))
