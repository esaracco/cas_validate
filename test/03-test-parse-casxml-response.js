
const tap = require('tap')
const fs = require('fs')
const env = process.env;
const chost = env.CAS_HOST || 'cas';
const cport = env.CAS_PORT || '8443';
const cuser = env.CAS_USER || 'tuser';
const cpass = env.CAS_PASS || 'test';
const casservice = 'https://'+chost+':'+cport+'/cas'
const casurl = casservice + '/login'

const testhost = env.CAS_VALIDATE_TEST_URL || 'cas_node_tests'
var testport = env.CAS_VALIDATE_TEST_PORT || 3000

const request = require('request');
const agentOptions = {
    host: 'www.example.com'
    , port: '443'
    , path: '/'
    , rejectUnauthorized: false
}

const redishost = env.REDIS_HOST || 'redis'
const redis = require('redis')

const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const connect = require('connect')

process.env.CAS_SESSION_TTL=2
const cas_validate = require('../lib/cas_validate')
const https = require('https')


// need to set up a server running bits and pieces of cas validate to test this properly.
// because the tests are responding to incoming connections.

function _login_handler(b){
    // parse the body for the form url, with the correct jsessionid
    var form_regex = /id="fm1".*action="(.*)">/;
    var result = form_regex.exec(b)
    console.log("login handler form parse is ", result[0], result[1])
    var opts={}
    opts.url=casservice+'/'+result[1]
    opts.form={'username':cuser
               ,'password':cpass
               ,'submit':'LOGIN'
              }
    // scrape hidden input values
    var name_regex = /name="(.*?)"/
    var value_regex = /value="(.*?)"/
    var hidden_regex = /<input.*?type="hidden".*?\/>/g
    while ((result = hidden_regex.exec(b)) !== null)
    {
        console.log("hidden form value:", result[0])
        var n = name_regex.exec(result[0])
        var v = value_regex.exec(result[0])
        if (v){
            opts.form[n[1]]=v[1]
        }else{
            opts.form[n[1]]=null
        }
    }
    console.log('opts is' )
    console.log(opts)
    console.log('--' )
    return opts
}


function cas_login_function(j){
    console.log('log in with cookie jar j=',j)
    var opts ={'url':casurl
               , 'jar': j
               , 'agentOptions': {
                   'rejectUnauthorized': false
               }
               ,"followRedirect":true
              }
    console.log(opts)
    const result = new Promise((resolve,reject)=>{
        request(opts
           ,(e,r,b)=>{
               //console.log('called cas/login, response is:', b, '\ncookie jar is', j)
               console.log('cookies are:',j.getCookies(casurl))
               Object.assign(opts,_login_handler(b))
               console.log('parsed response, going to log in with options:', opts)
               request.post(opts
                            ,(ee,rr,bb)=>{
                                if(ee){
                                    console.log('post error',ee)
                                }
                                var success_regex = /Log In Successful/i;
                                console.log('back from login attempt\n',
                                            '\nbody is \n',bb,
                                            '\nresponse is\n',rr,
                                            '\njar is', j)
                                if(success_regex.test(bb)){
                                    console.log('successful login. ', success_regex.exec(bb))
                                    return resolve(j)
                                }else{
                                    return reject('CAS login failed')
                                }
                            })
           })
    })
    return result
}

function cas_logout_function(rq,callback){
    var logouturl = 'https://'+chost + '/cas/logout';
    rq(logouturl
       ,function(e,r,b){
           // give the server a chance to fire off its post
           setTimeout(function(){
               callback(e,rq)
           },100)
       })
}

function setup_server(){
    const port = testport
    const store = new RedisStore({host:redishost,  ttl: 100})
    const app = connect()
          .use(session({ 'store': store,
                         'secret': 'barley waterloo napoleon',
                         'resave': false,
                         'saveUninitialized': true,

                       }))
          .use('/attributes'
               ,cas_validate.ticket({'cas_host':chost
                                     ,'service':'https://'+testhost +':'+port+'/attributes'}))
          .use('/attributes'
               ,cas_validate.check_and_return({'cas_host':chost
                                               ,'service':'https://'+testhost +':'+port+'/attributes'}))
          .use('/attributes'
               ,function(req,res,next){
                   cas_validate.get_attributes(req,function(err,obj){
                       console.log('got attributes', err, obj)
                       if(err){
                           res.end(JSON.stringify({}))
                           return null
                       }
                       res.setHeader('Content-Type','application/json');
                       res.end(JSON.stringify(obj))
                       return null
                   })
                   return null
               })
          .use(cas_validate.ticket({'cas_host':chost
                                    ,'service':'https://'+testhost +':'+port+'/'}))
          .use(cas_validate.check_or_redirect({'cas_host':chost
                                               ,'service':'https://'+testhost +':'+port+'/'}))
          .use('/',function(req, res, next){
              res.end('hello world')
          })
          .use(function(req, res, next){
              res.statusCode = 404
              res.end('bad news kid\n')
              return null
          })
    return new Promise((resolve,reject)=>{

        const options = {
            key: fs.readFileSync('test/fixtures/keys/key.pem'),
            cert: fs.readFileSync('test/fixtures/keys/cert.pem')
        };

        const server = https.createServer(options,app)
        server.listen(port, testhost, function(){
            console.log('server up:',testhost,port)
            resolve({'server':server,
                     'store':store,
                     'port':port})
        })
    })

}


function close_server(server_store){
    console.log('closing server')
    const result = new Promise(resolve => {
        server_store.store.client.quit()
        server_store.server.close( (e,r)=>{
            console.log('server closed')
            return resolve()
        })
    })
    return result
}

async function no_session(t){
    const server_store = t.context.server_store
    const myport = server_store.port
    const j = request.jar()


    const result = new Promise((resolve,reject) => {
        request({'url': 'https://'+ testhost + ':' + myport + '/attributes'
                 , 'jar': j
                 ,agentOptions: {
                     rejectUnauthorized: false
                 }
                 ,followRedirect:true}
                , (e,r,b) => {
                    try {
                        // console.log('e is ',e)
                        // console.log('r is ',r)
                        t.notOk(e)
                        console.log('b is ',b)
                        t.equal(r.statusCode,200)
                        t.ok(b)
                        t.same(JSON.parse(b),{})
                    }catch(e){
                        console.log(e)
                        t.fail()
                        return reject(e)
                    }
                    return resolve()
                });
    })
    await result
        .catch( e =>{
            console.log(e)
        })
    t.end()

}

async function user_name_session(t){
    console.log('testing with a real user')
    const server_store = t.context.server_store
    const myport = server_store.port
    const j = request.jar()

    const result = new Promise((resolve,reject) => {
        // set up a session with CAS server
        cas_login_function(j)
            .then((jj)=>{
                console.log('logged in, now try to get attributes')

                request({'url': 'https://'+ testhost + ':' + myport + '/attributes'
                         , 'jar': jj
                         ,agentOptions: {
                             rejectUnauthorized: false
                         }
                         ,followRedirect:true}
                        , (e,r,b) => {
                            try {
                                t.notOk(e)
                                //console.log('e is ',e)
                                //console.log('r is ',r)
                                console.log('b is ',b)
                                t.equal(r.statusCode,200)
                                t.ok(b)
                                const u = JSON.parse(b)
                                const expected_fields = ['commonName','givenName','sn','principalLdapDn']
                                expected_fields.forEach( (param) => {
                                    t.ok(u[param])
                                })

                            }catch(e){
                                console.log(e)
                                t.fail()
                                return reject(e)
                            }
                            return resolve()
                        });
            })
            .catch((e)=>{
                console.log('login error?',e)
                return resolve()
            })
    })
    await result
        .catch( e =>{
            console.log(e)
        })
    console.log('user name test is over')
    t.end()

}


setup_server()
    .then(server_store =>{
        tap.context.server_store = server_store
        tap.test('should reply with an empty json object when no session is established',no_session)
            .then( ()=>{
                tap.test('should return the current user name when there is a session',user_name_session)

                    .then(()=>{
                        console.log('comes second')
                        tap.end()
                        return close_server(server_store)
                    })
            })
    })