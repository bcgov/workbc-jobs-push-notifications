import { QueryResult } from "pg"
import { notificationsApi, jobsApi } from "./config/api-config"

const express = require("express")
const cookieParser = require("cookie-parser")
const helmet = require("helmet")
const cors = require("cors")
const cron = require("node-cron")
const db = require("./config/db-config")

const corsOptions = {
    origin: process.env.ORIGIN_URL || process.env.OPENSHIFT_NODEJS_ORIGIN_URL || "https://localhost:8000",
    credentials: true,
    optionsSuccessStatus: 200
}

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cors(corsOptions))
app.use(cookieParser())
app.use(helmet())

const port = process.env.PORT || "8000"
app.listen(port, () => {
    console.log(`server started at http://localhost:${port}`)
})

cron.schedule("*/15 * * * * *", async () => {
    console.log("===== START CRON JOB =====")
    const minimumPostedDate = new Date()
    minimumPostedDate.setDate(minimumPostedDate.getDate() - 1)
    const usersNotified: string[] = []

    try {
        console.log("Getting list of all stored job searches...")
        await db.query(
            `
            SELECT js.user_id, js.keyword, js.location, js.language, t.token, t.platform
            FROM job_searches js
            INNER JOIN tokens t ON js.user_id = t.user_id
            `,
            []
        )
            .then(async (jobSearches: QueryResult) => {
                console.log("Checking for new job postings...")
                // for each job search, check if there's new job postings //
                jobSearches.rows.forEach(async (row: any) => {
                    console.log(`keyword: ${row.keyword}, location: ${row.location}, user: ${row.user_id}`)
                    try {
                        const jobsResp = await jobsApi.get(
                            "Jobs",
                            {
                                data: {
                                    jobTitle: row.keyword,
                                    location: row.location,
                                    language: row.language,
                                    minimumPostedDate: minimumPostedDate
                                }
                            }
                        )

                        // if there is new job postings, and the user hasn't been sent a push notification yet, send them one //
                        if (jobsResp.data.count > 0 && !usersNotified.includes(row.user_id)) {
                            usersNotified.push(row.user_id)
                            try {
                                await notificationsApi.post(
                                    "Messaging/Send",
                                    {
                                        title: "New Jobs Posted",
                                        content: "There are new job postings for one or more of your saved job searches!",
                                        token: row.token,
                                        platform: row.platform,
                                        dryRun: false
                                    },
                                    {
                                        auth: {
                                            username: process.env.NOTIFICATIONS_API_USER || "",
                                            password: process.env.NOTIFICATIONS_API_PASS || ""
                                        }
                                    }
                                )
                            } catch (e: any) {
                                console.log(e.message)
                            }
                        }
                    } catch (e: any) {
                        console.log(e.message)
                    }
                })
            })

        console.log("===== END CRON JOB =====")
    } catch (e: any) {
        console.log(e.message)
    }
})
